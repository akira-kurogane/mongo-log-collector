#!/bin/bash
set -e

if [ $# -lt 1 ]; then
  echo -e "Error: this script requires monogbd node's <host>:<port> value as an argument.\n  (It should be to a mongos node if you are collecting logs from an entire\n  cluster. For a replica set any one node is sufficient.)" >&2
  exit 1
fi
mhostport=${1}

#printHostInfosAsTSV() prints 2 or 3 tab-separated columns: process type (mongod or mongos), host-post string,
#  and a ";"-delimited string of optional properties such as replica set name
mongo --quiet ${mhostport} --eval 'load("'${PWD}'/walk_the_nodes.js"); load("'${PWD}'/topology_to_tsv.js"); printHostInfosAsTSV(db.serverStatus().host);' | while read ptype hp opts; do
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
done
