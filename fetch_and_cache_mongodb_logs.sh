#!/bin/bash
set -e

if [ -z "$(which getopt)" ]; then
  echo "No \"getopt\" util found in PATH. Aborting." >&2
  exit 1
fi

#Reformat the command line args/option for simpler parsing by using the getopt command
getopt_output=$(getopt -o s:e:p --long start-ts:,end-ts:,argc -n $(basename $0) -- "$@")
eval set -- "$getopt_output"
while true ; do
    case "$1" in
        -s|--start-ts)
            case "$2" in
                "") start_ts='some default value' ; shift 2 ;;
                *) start_ts=$2 ; shift 2 ;;
            esac ;;
        -e|--end-ts)
            case "$2" in
                "") shift 2 ;;
                *) end_ts=$2 ; shift 2 ;;
            esac ;;
        -p|--dry-run) dry_run=1 ; shift ;;
        --) shift ; break ;;
        *) echo "Unexpected options-parsing error. Aborting." >&2 ; exit 1 ;;
    esac
done

if [ $# -ne 1 ]; then #Expecting one and only one arg after options processed above
  echo -e "Error: this script requires monogbd node's <host>:<port> value as an argument.\n  (It should be to a mongos node if you are collecting logs from an entire\n  cluster. For a replica set any one node is sufficient.)" >&2
  exit 1
fi
mhostport=${1}

#TODO: confirm start_ts and end_ts are valid timestamps

this_script_dir=$(readlink -f $(dirname ${0}))

if [ -n "${start_ts}" -o -n "${end_ts}" ]; then
  #create a filename-safe version of the filter
  if [ -n "${start_ts}" -a -n "${end_ts}" ]; then
    fltr_name="${start_ts//[^A-Za-z0-9._-:]/}_to_${end_ts//[^A-Za-z0-9._-:]/}"
  elif [ -n "${start_ts}" ]; then
    fltr_name="${start_ts//[^A-Za-z0-9._-:]/}_to_current"
  else
    fltr_name="earliest_to_${end_ts//[^A-Za-z0-9._-:]/}"
  fi
  fetch_dir=mongo_logs_${fltr_name}
else #fetch full files, no filtering
  fetch_dir=mongo_logs_full
fi

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

if [ -n "${dry_run}" ]; then
  echo "Exiting now because dry-run option was set"
  exit 0
fi

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
  mkdir -p ${fetch_dir}/${hp}
  if [ -n "${start_ts}" -o -n "${end_ts}" ]; then
  #if [ -n "${start_ts}" -o -n "${end_ts}" -o -n "${filter_regex}" ]; then
    #Begin scan of logfile by either using sed to start output from start_ts, or cat to
    #  get all. cat isn't necessary, it's just convenient for building ssh_cmd
    if [ -n "${start_ts}" ]; then
      ssh_cmd="sed '0,/^${start_ts}/d' ${lf}"
    else
      ssh_cmd="cat ${lf}"
    fi
    #if [ -n "${filter_regex}" ]; then
    #  ssh_cmd="${ssh_cmd} | grep '${fltr_match}'"
    #fi
    if [ -n "${end_ts}" ]; then
      ssh_cmd="${ssh_cmd} | sed '/^${end_ts}/q'"
    fi
echo "ssh_cmd = ${ssh_cmd} > ${fetch_dir}/${hp}/$(basename ${lf})"
    ssh ${h} "${ssh_cmd}" > ${fetch_dir}/${hp}/$(basename ${lf})
  else #copy full files
    if [ -n "$(which rsync)" ]; then #use rsync if available
      rsync -t ${h}:${lf} ${fetch_dir}/${hp}/$(basename ${lf})
      echo "${hp} ${ptype} log file copied by rsync to ${fetch_dir}/${hp}/"
    else
      scp ${h}:${lf} ${fetch_dir}/${hp}/
      echo "${h} ${ptype} log file scp'ed to ${fetch_dir}/${hp}/"
    fi
  fi
done < ${hostinfo_tmpfile}

rm -f "${hostinfo_tmpfile}*"
