/**
 * Execute this script using the mongo shell. E.g. shell command to do that.
 * mongo --quiet <host>:<port> --eval 'load("'${PWD}'/walk_the_nodes.js"); load("'${PWD}'/topology_to_tsv.js"); printHostInfosAsTSV(db.serverStatus().host);'
 */

function printHostInfosAsTSV(starting_node_hostport) {
  //The "walkNode" function is defined in walk_the_nodes.js include script.
  //  It will get info about all mongodb nodes belonging to the same cluster or
  //  replica set the starting node belongs too.
  var all_hosts_info = walkNode(starting_node_hostport);

  all_hosts_info.forEach(function(hi) { 
      var oprops = []; //Important properties other than process type or hostport address.
      if (hi.cmdLineOpts.parsed.systemLog && hi.cmdLineOpts.parsed.systemLog.path)
        oprops.push("logpath=" + hi.cmdLineOpts.parsed.systemLog.path);
      if (hi.rsstatus) {
        oprops.push("replSet=" + hi.rsstatus.set);
        hi.rsstatus.members.forEach(function(m) {
          if (m.self) {
            oprops.push("replState=" + m.stateStr);
          }
        });
      }
      if (hi.cmdLineOpts.parsed.sharding && hi.cmdLineOpts.parsed.sharding.clusterRole) {
        oprops.push("clusterRole=" + hi.cmdLineOpts.parsed.sharding.clusterRole);
      }
      print(hi.serverStatusOutput.process + "\t" + hi.serverStatusOutput.host + "\t" + oprops.join(";")
    ); } );

}
