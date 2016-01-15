#!/bin/bash
set -e

if [ $# -lt 1 ]; then
  echo -e "Error: this script requires monogbd node's <host>:<port> value as an argument.\n  (It should be to a mongos node if you are collecting logs from an entire\n  cluster. For a replica set any one node is sufficient.)" >&2
  exit 1
fi
mhostport=${1}
this_script_dir=$(readlink -f $(dirname ${0}))

hostinfo_tmpfile=$(mktemp /tmp/mlc_hostinfo.XXXXXX)

#printHostInfosAsTSV() prints 2 or 3 tab-separated columns: process type (mongod or mongos), host-port string,
#  and a ";"-delimited string of optional 'key=value' properties such as replica set name.
#  E.g. "cut -f 2 | sed 's/:.*//' | sort | uniq" gives unique server hostnames
#  E.g. "grep 'replState=PRIMARY'" filters to only include primary nodes
#  E.g. "grep clusterRole=configsvr | head -n 1" limits the output to be one confgisvr only
mongo --quiet ${mhostport} --eval 'load("'${this_script_dir}'/walk_the_nodes.js"); load("'${this_script_dir}'/topology_to_tsv.js"); printHostInfosAsTSV(db.serverStatus().host);' > ${hostinfo_tmpfile}

echo "$(grep -c 'logpath=' ${hostinfo_tmpfile}) logfiles on $(cut -f 2 ${hostinfo_tmpfile} | sed 's/:.*//' | sort | uniq | wc -l) hosts found"

#Test ssh connections to all hosts are permitted. Print nothing if all OK.
sshconfirmed_tmpfile=${hostinfo_tmpfile}.ssh_confirmed
cp ${hostinfo_tmpfile} ${sshconfirmed_tmpfile}
for hostnm in $(cut -f 2 ${hostinfo_tmpfile} | sed 's/:.*//' | sort | uniq); do
  sshfail=
  ssh -o 'ConnectTimeout=2' ${hostnm} ":" || sshfail=1
  if [ -n "${sshfail}" ]; then
    echo "SSH connection to ${hostnm} rejected / timed-out. The $(grep -c ${hostnm} ${hostinfo_tmpfile}) logfile(s) on that server will be skipped." >&2
    sed '/^\S\S*\t'${hostnm}'\S*\t/d' ${sshconfirmed_tmpfile} > ${sshconfirmed_tmpfile}.x && mv ${sshconfirmed_tmpfile}.x ${sshconfirmed_tmpfile}
  fi
done
if [ ! -s "${sshconfirmed_tmpfile}" ]; then
  echo -e "As no SSH connections could be established to any server no SCP or rysnc copying will be\n  possible. Aborting." >&2
  rm -f ${sshconfirmed_tmpfile} ${hostinfo_tmpfile}
  exit 1
fi
mv ${sshconfirmed_tmpfile} ${hostinfo_tmpfile}

while read ptype hp opts; do
  h=${hp%%:*}
  #Change the opts string to be space delimited now
  opts=${opts//;/ }
  for opt in ${opts}; do
    if [ "${opt%%=*}" == "logpath" ]; then 
     lf=${opt##*=} 
    fi
  done
  #echo "${ptype} process ${hp} on host ${h} has logpath = ${lf}"
  mkdir -p mongo_log_cache/${hp}
  if [ -n "$(which rsync)" ]; then #use rsync if available
    rsync -t ${h}:${lf} mongo_log_cache/${hp}/$(basename ${lf})
    echo "${hp} ${ptype} log file copied by rsync to mongo_log_cache/${hp}/"
  else
    scp ${h}:${lf} mongo_log_cache/${hp}/
    echo "${h} ${ptype} log file scp'ed to mongo_log_cache/${hp}/"
  fi
done < ${hostinfo_tmpfile}

rm -f "${hostinfo_tmpfile}*"
