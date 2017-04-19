#!/bin/bash
set -e

if [ -z "$(which getopt)" ]; then
  echo "No \"getopt\" util found in PATH. Aborting." >&2
  exit 1
fi

#Reformat the command line args/option for simpler parsing by using the getopt command
getopt_output=$(getopt -o s:e:r:p --long start-ts:,end-ts:filter-regex:,dry-run -n $(basename $0) -- "$@")
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
        -r|--filter-regex)
            case "$2" in
                "") shift 2 ;;
                *) filter_regex=$2 ; shift 2 ;;
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
  if [ -n "${filter_regex}" ]; then
    fltr_name="${fltr_name}_${filter_regex//[^A-Za-z0-9._-:]/}"
  fi
  fetch_dir=mongo_logs_${fltr_name}
else #fetch full files, no filtering
  fetch_dir=mongo_logs_full
fi

# A list of hosts and mongodb processes will be saved into a temp file.
hostinfo_tmpfile=$(mktemp /tmp/mlc_hostinfo.XXXXXX)

##
# The mongo shell function printHostInfosAsTSV() prints 2 or 3 tab-separated
#   columns: process type (mongod or mongos), host-port string, and a 
#   ";"-delimited string of optional 'key=value' properties such as replica set
#   name.
# E.g. "cut -f 2 | sed 's/:.*//' | sort | uniq" gives unique server hostnames
# E.g. "grep 'replState=PRIMARY'" filters to only include primary nodes
# E.g. "grep clusterRole=configsvr | head -n 1" limits the output to be one
#   configsvr only
##
mongo --quiet ${mhostport} --eval 'load("'${this_script_dir}'/walk_the_nodes.js"); load("'${this_script_dir}'/topology_to_tsv.js"); printHostInfosAsTSV(db.serverStatus().host);' > ${hostinfo_tmpfile}

##
# In 3.4 there can be some logfile-like warnings appearing in the stdout of the
#   walk_the_nodes.js eval above, despite the use of the --quiet flag. Removing
#   them by matching on the ISO 8601 timestamp at the front of log lines.
##
sed -'/^20..-..-..T..:..:/d' ${hostinfo_tmpfile} > ${hostinfo_tmpfile}.clean && mv ${hostinfo_tmpfile}.clean ${hostinfo_tmpfile}

hcount=$(cut -f 2 ${hostinfo_tmpfile} | sed 's/:.*//' | sort | uniq | wc -l)
echo "$(grep -c 'logpath=' ${hostinfo_tmpfile}) logfiles on ${hcount} hosts found"

#  TODO: add host type filtering here. E.g. if a "--no-configsvrs" argument is
#   supplied run: sed -i '/clusterRole=configsvr/d' ${hostinfo_tmpfile}. If
#   "--no-secondaries" then run: sed -i '/replState=SECONDARY/d' ${hostinfo_tmpfile}

#  TODO: remove processes who have a relative rather than absolute logfile paths,
#   giving a warning. We could try to work it out by peeking into the 
#   /proc/<pid>/fd directory, but that's a bit messy. It's probably the 4 fd,
#   and it's probably the only one with a "flags" line in it's
#   /proc/<pid>/fdinfo that shows it has append-only mode, but neither of those
#   seem 100.00% certain.

##
# Test ssh connections to all hosts. Print nothing if all OK. If ssh connection
#   fails print warning, and remove those lines from ${hostinfo_tmpfile}
##
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

##
# The fetching part. If the --dry-run argument is used this will just debug-
#   print the command instead of running (except if rsync, which has a 
#   a --dry-run mode we can use).
# If filtering arguments are used a ssh command running awk and/or grep on 
#   the remote hosts will be executed, outputing to a local copy. 'Filtering' 
#   means time-span filtering and grep expression filter.
# If no filtering arguments are used full file copies by rsync or scp are
#   executed.
# Todo: putting all the filter ssh cmd building inside the loop run for 
#   each file is unnecessary repetition. Remove that logic to a block before
#   this one, one that makes the ssh_cmd string with a "INPUTFILEPATH" token
#   in it that can be replaced simply with the source file path each loop
#   below.
###
echo -e "Fetching logs. Local cache directory=\n  ${fetch_dir}/" >&2
while read ptype hp opts; do
  h=${hp%%:*}
  #Change the opts string to be space delimited, for simple iteration
  opts=${opts//;/ }
  for opt in ${opts}; do
    if [ "${opt%%=*}" == "logpath" ]; then 
     lf=${opt##*=} 
    fi
  done
  output_path=${fetch_dir}/${hp}/$(basename ${lf})
  mkdir -p ${fetch_dir}/${hp}
  if [ -n "${start_ts}" -o -n "${end_ts}" -o -n "${filter_regex}" ]; then
    #Begin scan of logfile by either using sed to start output from start_ts, or cat to
    #  get all. cat isn't necessary, it's just convenient for building ssh_cmd
    if [ -n "${start_ts}" ]; then
      ssh_cmd="awk 'BEGIN { while (\$0 !~ /^201[56]-[01][0-9]-[01][0-9]T/ || \$0 < \"${start_ts}\") { getline; } print; } {print}' ${lf}"
    else
      ssh_cmd="cat ${lf}"
    fi
    if [ -n "${filter_regex}" ]; then
      ssh_cmd="${ssh_cmd} | grep '${filter_regex}'"
    fi
    if [ -n "${end_ts}" ]; then
      ssh_cmd="${ssh_cmd} | awk '{ if (\$0 ~ /^201[56]-[01][0-9]-[01][0-9]T/ && \$0 >= \"${end_ts}\") { exit; } }'"
    fi
    if [ -n "${dry_run}" ]; then
      echo DRYRUN: ssh ${h} '"'$ssh_cmd'"' ">" ${output_path}
    else
      #Devnote: the -n argument is required. It prevents ssh from reading stdin,
      #  i.e. prevents it from reading and finishing FILE content in the
      #  'while ... do; ...; done < FILE' loop that surrounds this command.
      ssh -n ${h} ${ssh_cmd} > ${output_path}
      echo "Filtered loglines output to ${hp}/$(basename ${lf})" >&2
    fi 
  else #copy full files
    if [ -n "$(which rsync)" ]; then #use rsync if available
      if [ -n "${dry_run}" ]; then
        rsync --dry-run -tv ${h}:${lf} ${fetch_dir}/${hp}/$(basename ${lf})
      else
        rsync -t ${h}:${lf} ${fetch_dir}/${hp}/$(basename ${lf})
      fi
      echo "${hp} ${ptype} log file copied by rsync to ${fetch_dir}/${hp}/"
    else
      if [ -n "${dry_run}" ]; then
        echo "DRYRUN: scp ${h}:${lf} ${fetch_dir}/${hp}/"
      else
        scp ${h}:${lf} ${fetch_dir}/${hp}/
      fi
      echo "${h} ${ptype} log file scp'ed to ${fetch_dir}/${hp}/"
    fi
  fi
done < ${hostinfo_tmpfile}

rm -f "${hostinfo_tmpfile}*"
