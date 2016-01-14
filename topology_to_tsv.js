function printHostInfosAsTSV() {
  //walkNode function defined in walk_the_nodes.js include script
  //Start the walk by passing the hostport address of this first mongod/mongos connected to.
  var all_hosts_info = walkNode(db.serverStatus().host);

  all_hosts_info.forEach(function(hi) { 
      var optional_properties = [];
      if (hi.parsedOpts.systemLog && hi.parsedOpts.systemLog.path)
        optional_properties.push("logpath=" + hi.parsedOpts.systemLog.path);
      if (hi.rsstatus) {
        optional_properties.push("replSet=" + hi.rsstatus.set);
        hi.rsstatus.members.forEach(function(m) {
          if (m.self) {
            optional_properties.push("replState=" + m.stateStr);
          }
        });
      }
      print(hi.serverStatus.process + "\t" + hi.serverStatus.host + "\t" + optional_properties.join(";")
    ); } );

}
