#!/bin/bash
set -e

mongo --quiet ip-172-31-3-30:37001 --eval 'load("'${PWD}'/walk_the_nodes.js"); load("'${PWD}'/topology_to_tsv.js"); printHostInfosAsTSV();'
