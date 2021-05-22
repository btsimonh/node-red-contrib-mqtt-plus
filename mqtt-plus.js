/**
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 **/

 module.exports = function(RED) {
  "use strict";
  var mqtt = require("mqtt");
  var util = require("util");
  var isUtf8 = require('is-utf8');
  var HttpsProxyAgent = require('https-proxy-agent');
  var url = require('url');
  
  function matchTopic(ts,t) {
      if (ts == "#") {
          return true;
      }
      var re = new RegExp("^"+ts.replace(/([\[\]\?\(\)\\\\$\^\*\.|])/g,"\\$1").replace(/\+/g,"[^/]+").replace(/\/#$/,"(\/.*)?")+"$");
      return re.test(t);
  }

  function MQTTBrokerNode(n) {
      RED.nodes.createNode(this,n);

      // Configuration options passed by Node Red
      this.broker = n.broker;
      this.port = n.port;
      this.clientid = n.clientid;
      this.usetls = n.usetls;
      this.verifyservercert = n.verifyservercert;
      this.compatmode = n.compatmode;
      this.keepalive = n.keepalive;
      this.cleansession = n.cleansession;

      // Config node state
      this.brokerurl = "";
      this.connected = false;
      this.connecting = false;
      this.closing = false;
      this.options = {};
      this.queue = [];
      this.subscriptions = {};

      if (n.birthTopic) {
          this.birthMessage = {
              topic: n.birthTopic,
              payload: n.birthPayload || "",
              qos: Number(n.birthQos||0),
              retain: n.birthRetain=="true"|| n.birthRetain===true
          };
      }

      if (this.credentials) {
          this.username = this.credentials.user;
          this.password = this.credentials.password;
      }

      // If the config node is missing certain options (it was probably deployed prior to an update to the node code),
      // select/generate sensible options for the new fields
      if (typeof this.usetls === 'undefined') {
          this.usetls = false;
      }
      if (typeof this.compatmode === 'undefined') {
          this.compatmode = true;
      }
      if (typeof this.verifyservercert === 'undefined') {
          this.verifyservercert = false;
      }
      if (typeof this.keepalive === 'undefined') {
          this.keepalive = 60;
      } else if (typeof this.keepalive === 'string') {
          this.keepalive = Number(this.keepalive);
      }
      if (typeof this.cleansession === 'undefined') {
          this.cleansession = true;
      }

      var prox, noprox;
      if (process.env.http_proxy != null) { prox = process.env.http_proxy; }
      if (process.env.HTTP_PROXY != null) { prox = process.env.HTTP_PROXY; }
      if (process.env.no_proxy != null) { noprox = process.env.no_proxy.split(","); }
      if (process.env.NO_PROXY != null) { noprox = process.env.NO_PROXY.split(","); }
     
      // Create the URL to pass in to the MQTT.js library
      if (this.brokerurl === "") {
          // if the broken may be ws:// or wss:// or even tcp://
          if (this.broker.indexOf("://") > -1) {
              this.brokerurl = this.broker;
              // Only for ws or wss, check if proxy env var for additional configuration
              if (this.brokerurl.indexOf("wss://") > -1 || this.brokerurl.indexOf("ws://") > -1 ) {
                  // check if proxy is set in env
                  var noproxy;
                  if (noprox) {
                      for (var i in noprox) {
                          if (this.brokerurl.indexOf(noprox[i].trim()) !== -1) { noproxy=true; }
                      }
                  }
                  if (prox && !noproxy) {
                      var parsedUrl = url.parse(this.brokerurl);
                      var proxyOpts = url.parse(prox);
                      // true for wss
                      proxyOpts.secureEndpoint = parsedUrl.protocol ? parsedUrl.protocol === 'wss:' : true;
                      // Set Agent for wsOption in MQTT
                      var agent = new HttpsProxyAgent(proxyOpts);
                      this.options.wsOptions = {
                          agent: agent
                      }
                  }                
              }
          } else {
              // construct the std mqtt:// url
              if (this.usetls) {
                  this.brokerurl="mqtts://";
              } else {
                  this.brokerurl="mqtt://";
              }
              if (this.broker !== "") {
                  this.brokerurl = this.brokerurl+this.broker+":";
                  // port now defaults to 1883 if unset.
                  if (!this.port){
                      this.brokerurl = this.brokerurl+"1883";
                  } else {
                      this.brokerurl = this.brokerurl+this.port;
                  }
              } else {
                  this.brokerurl = this.brokerurl+"localhost:1883";
              }
          }
      }

      if (!this.cleansession && !this.clientid) {
          this.cleansession = true;
          this.warn(RED._("mqtt.errors.nonclean-missingclientid"));
      }

      // Build options for passing to the MQTT.js API
      this.options.clientId = this.clientid || 'mqtt_' + (1+Math.random()*4294967295).toString(16);
      this.options.username = this.username;
      this.options.password = this.password;
      this.options.keepalive = this.keepalive;
      this.options.clean = this.cleansession;
      this.options.reconnectPeriod = RED.settings.mqttReconnectTime||5000;
      if (this.compatmode == "true" || this.compatmode === true) {
          this.options.protocolId = 'MQIsdp';
          this.options.protocolVersion = 3;
      }
      if (this.usetls && n.tls) {
          var tlsNode = RED.nodes.getNode(n.tls);
          if (tlsNode) {
              tlsNode.addTLSOptions(this.options);
          }
      }
      // If there's no rejectUnauthorized already, then this could be an
      // old config where this option was provided on the broker node and
      // not the tls node
      if (typeof this.options.rejectUnauthorized === 'undefined') {
          this.options.rejectUnauthorized = (this.verifyservercert == "true" || this.verifyservercert === true);
      }

      if (n.willTopic) {
          this.options.will = {
              topic: n.willTopic,
              payload: n.willPayload || "",
              qos: Number(n.willQos||0),
              retain: n.willRetain=="true"|| n.willRetain===true
          };
      }

      // Define functions called by MQTT in and out nodes
      var node = this;
      this.users = {};

      this.register = function(mqttNode) {
          node.users[mqttNode.id] = mqttNode;
          if (Object.keys(node.users).length === 1) {
              node.connect();
          }
          // if already connected, tell this new node.
          if (node.connected){
              if(mqttNode.onconnect){
                  mqttNode.onconnect();
              }
          }
      };

      this.deregister = function(mqttNode,done) {
          delete node.users[mqttNode.id];
          if (node.closing) {
              return done();
          }
          if (Object.keys(node.users).length === 0) {
              if (node.client && node.client.connected) {
                  return node.client.end(done);
              } else {
                  node.client.end();
                  return done();
              }
          }
          done();
      };

      
      this.changecredentials = function(user, pass){
          // allow for user or pass to be undefined
          user = user || node.options.username;
          pass = pass || node.options.password;
          
          //console.log("Br: u:" + user + " p:"+pass);

          // do nothing if they will not change
          if ((node.options.username !== user) || (node.options.password !== pass)){
              //console.log("setting");
              node.options.username = user;
              node.options.password = pass;
              if (node.client){
                  var oldclient = node.client;
                  node.client = null;
                  oldclient.removeListener('close', node.onclose);
                  oldclient.removeListener('error', node.onerror);
                  oldclient.removeListener('connect', node.onconnect);
                  oldclient.removeListener('reconnect', node.onreconnect);
                  // leave message listener(s) attached
                  oldclient.on('close', ()=>{
                      console.log("oldclient onclose()");
                      if (node.connected) {
                          node.connected = false;
                          node.log(RED._("mqtt.state.disconnected",{broker:(node.clientid?node.clientid+"@":"")+node.brokerurl}));
                          for (var id in node.users) {
                              if (node.users.hasOwnProperty(id)) {
                                  node.users[id].ondisconnect();
                                  //node.users[id].status({fill:"red",shape:"ring",text:"node-red:common.status.disconnected"});
                              }
                          }
                      } else if (node.connecting) {
                          node.log(RED._("mqtt.state.connect-failed",{broker:(node.clientid?node.clientid+"@":"")+node.brokerurl}));
                      }
                  });
                  // Register connect error handler
                  oldclient.on('error', (error)=>{
                      console.log("old client onerror");
                  });
                  
                  oldclient.end(()=>{
                      console.log("old client end complete");
                  });
                  
                  console.log("change cred - removed old client");
                  node.connected = false;
                  node.connecting = false;
              }
              console.log("change cred - connect");
              node.connect();
          }
      };
      

      this.connect = function () {
          if (!node.connected && !node.connecting) {
              node.connecting = true;
              node.client = mqtt.connect(node.brokerurl ,node.options);
              node.client.setMaxListeners(0);
              console.log("connect()");
              // Register successful connect or reconnect handler
              node.onconnect = ()=>{
                  console.log("onconnect()");
                  node.connecting = false;
                  node.connected = true;
                  node.log(RED._("mqtt.state.connected",{broker:(node.clientid?node.clientid+"@":"")+node.brokerurl + " as " + node.options.username}));
                  for (var id in node.users) {
                      if (node.users.hasOwnProperty(id)) {
                          //node.users[id].status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
                          if(node.users[id].onconnect){
                              node.users[id].onconnect();
                          }
                      }
                  }
                  // Remove any existing listeners before resubscribing to avoid duplicates in the event of a re-connection
                  node.client.removeAllListeners('message');

                  // Re-subscribe to stored topics
                  for (var s in node.subscriptions) {
                      if (node.subscriptions.hasOwnProperty(s)) {
                          var topic = s;
                          var qos = 0;
                          for (var r in node.subscriptions[s]) {
                              if (node.subscriptions[s].hasOwnProperty(r)) {
                                  qos = Math.max(qos,node.subscriptions[s][r].qos);
                                  node.client.on('message',node.subscriptions[s][r].handler);
                              }
                          }
                          var options = {qos: qos};
                          //node.client.subscribe(topic, options);
                          node.client.subscribe(topic, options, (err, granted)=>{
                              for (var r in node.subscriptions[topic]) {
                                  if (node.subscriptions[topic].hasOwnProperty(r)) {
                                      var that = node.subscriptions[topic][r].that;
                                      if (granted){
                                          if (granted.length){
                                              if (that.suberror){
                                                  that.suberror(granted[0].qos);
                                              }
                                          }
                                      } else {
                                          console.log("subscribe error "+util.inspect(err));
                                          that.suberror(129);
                                      }
                                  }
                              }
                          });
                      }
                  }

                  // Send any birth message
                  if (node.birthMessage) {
                      node.publish(node.birthMessage);
                  }
              };
              node.client.on('connect', node.onconnect);
              node.onreconnect = function() {
                  for (var id in node.users) {
                      if (node.users.hasOwnProperty(id)) {
                          node.users[id].onreconnecting();
                          //node.users[id].status({fill:"yellow",shape:"ring",text:"node-red:common.status.connecting"});
                      }
                  }
              };
              node.client.on("reconnect", node.onreconnect);
              // Register disconnect handlers
              node.onclose = function () {
                  console.log("onclose()");
                  if (node.connected) {
                      node.connected = false;
                      node.log(RED._("mqtt.state.disconnected",{broker:(node.clientid?node.clientid+"@":"")+node.brokerurl}));
                      for (var id in node.users) {
                          if (node.users.hasOwnProperty(id)) {
                              node.users[id].ondisconnect();
                              //node.users[id].status({fill:"red",shape:"ring",text:"node-red:common.status.disconnected"});
                              //if(node.users[id].onclose){
                              //    setTimeout(node.users[id].onclose(), 0);
                              //}
                          }
                      }
                  } else if (node.connecting) {
                      node.log(RED._("mqtt.state.connect-failed",{broker:(node.clientid?node.clientid+"@":"")+node.brokerurl}));
                  }
              };
              node.client.on('close', node.onclose);

              // Register connect error handler
              node.onerror = function (error) {
                  console.log("onerror()");
                  if (node.connecting) {
                      node.client.end();
                      node.connecting = false;
                  }
              };
              node.client.on('error', node.onerror);
          }
      };

      this.subscribe = (topic,qos,callback,ref, that)=>{
          ref = ref||0;
          node.subscriptions[topic] = node.subscriptions[topic]||{};
          var sub = {
              topic:topic,
              qos:qos,
              handler:function(mtopic,mpayload, mpacket) {
                  if (matchTopic(topic,mtopic)) {
                      callback(mtopic,mpayload, mpacket);
                  }
              },
              ref: ref,
              that:that
          };
          node.subscriptions[topic][ref] = sub;
          if (node.connected) {
              node.client.on('message',sub.handler);
              var options = {};
              options.qos = qos;
              node.client.subscribe(topic, options, function(err, granted){
                  if (granted){
                      if (granted.length){
                          if (that.suberror){
                              that.suberror(granted[0].qos);
                          }
                      }
                  } else {
                      console.log("subscribe error "+util.inspect(err));
                      that.suberror(129);
                  }
              });
          }
      };

      this.unsubscribe = (topic, ref)=>{
          ref = ref||0;
          var sub = node.subscriptions[topic];
          if (sub) {
              if (sub[ref]) {
                  node.client.removeListener('message',sub[ref].handler);
                  delete sub[ref];
              }
              if (Object.keys(sub).length === 0) {
                  delete node.subscriptions[topic];
                  if (node.connected) {
                      node.client.unsubscribe(topic);
                  }
              }
          }
      };

      this.publish = (msg, that)=>{
          if (node.connected) {
              var payload = msg.payload;
              if (!Buffer.isBuffer(payload)) {
                  if (typeof payload === "object") {
                      payload = JSON.stringify(payload);
                  } else if (typeof payload !== "string") {
                      payload = "" + payload;
                  }
              }

              var options = {
                  qos: msg.qos || 0,
                  retain: msg.retain || false
              };
              node.client.publish(msg.topic, payload, options, function(err) {
                  if (err){
                      msg.err = err;
                  }
                  that.send(msg);
                  return;
              });
          }
      };

      this.on('close', (done)=>{
          this.closing = true;
          if (this.connected) {
              this.client.once('close', function() {
                  done();
              });
              this.client.end();
          } else if (this.connecting || node.client.reconnecting) {
              node.client.end();
              done();
          } else {
              done();
          }
      });

  }

  RED.nodes.registerType("mqtt-plus-broker",MQTTBrokerNode,{
      credentials: {
          user: {type:"text"},
          password: {type: "password"}
      }
  });

  function MQTTInNode(n) {
      RED.nodes.createNode(this,n);
      this.topic = n.topic;
      this.qos = parseInt(n.qos);
      if (isNaN(this.qos) || this.qos < 0 || this.qos > 2) {
          this.qos = 2;
      }
      this.broker = n.broker;
      this.brokerConn = RED.nodes.getNode(this.broker);
      if (!/^(#$|(\+|[^+#]*)(\/(\+|[^+#]*))*(\/(\+|#|[^+#]*))?$)/.test(this.topic)) {
          return this.warn(RED._("mqtt.errors.invalid-topic"));
      }
      this.subscribedqos = 128;
      
      var node = this;
      
      if (this.brokerConn) {
          this.on("input",(msg)=>{
              if (((msg.cmd === 'subscribe') && (msg.topic)) || (msg.cmd === 'resubscribe')){
                  if (msg.cmd === 'subscribe'){
                      // don't resubscribe to the same topic if we don't need to
                      if (node.topic == msg.topic)
                          return;
                  }
                  node.brokerConn.unsubscribe(node.topic, node.id);
                  if (msg.cmd === 'subscribe'){
                      node.topic = msg.topic;
                  }
                  node.brokerConn.subscribe(node.topic,node.qos,function(topic,payload,packet) {
                      if (isUtf8(payload)) { payload = payload.toString(); }
                      var msg = {topic:topic,payload:payload, qos: packet.qos, retain: packet.retain};
                      if ((node.brokerConn.broker === "localhost")||(node.brokerConn.broker === "127.0.0.1")) {
                          msg._topic = topic;
                      }
                      node.send(msg);
                  }, node.id, node);
                  return;
              }
              
              if (msg.cmd === 'getconnected'){
                  this.onconnect();
                  return;
              }
          });
          
          this.status({fill:"red",shape:"ring",text:"node-red:common.status.disconnected"});
          if (this.topic) {
              node.brokerConn.register(this);
              this.brokerConn.subscribe(this.topic,this.qos,function(topic,payload,packet) {
                  if (isUtf8(payload)) { payload = payload.toString(); }
                  var msg = {topic:topic,payload:payload, qos: packet.qos, retain: packet.retain};
                  if ((node.brokerConn.broker === "localhost")||(node.brokerConn.broker === "127.0.0.1")) {
                      msg._topic = topic;
                  }
                  node.send(msg);
              }, this.id, this);
              if (this.brokerConn.connected) {
                  //node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
              }
          }
          else {
              this.error(RED._("mqtt.errors.not-defined"));
          }
          this.on('close', function(done) {
              if (node.brokerConn) {
                  node.brokerConn.unsubscribe(node.topic,node.id);
                  node.brokerConn.deregister(node,done);
              }
          });
      } else {
          this.error(RED._("mqtt.errors.missing-config"));
      }
      
      this.showandsendstate = ()=>{
          var con = this.brokerConn.connected;
          var newmsg = {
              subscribed:(node.subscribedqos < 3), 
              connected: con, 
              qos:node.subscribedqos,
              topic: node.topic
          };
          
          if (con){
              if (node.subscribedqos < 3){
                  node.status({fill:"green",shape:"dot",text:"subscribed at QOS "+node.subscribedqos});
              } else {
                  node.status({fill:"red",shape:"dot",text:"subscribe failed (QOS "+node.subscribedqos+")"});
              }
          } else {
              node.status({fill:"red",shape:"ring",text:"node-red:common.status.disconnected"});
              newmsg.qos = node.subscribedqos = 128;
          }
          node.send([null, newmsg]);
      };

      this.onconnect = this.showandsendstate;
      this.ondisconnect = this.showandsendstate;
      this.onreconnecting = function(){
          node.status({fill:"yellow",shape:"ring",text:"node-red:common.status.connecting"});
          var newmsg = {
              subscribed:false, 
              connected:false, 
              reconnecting:true, 
              qos: 128, 
              topic: node.topic
          };
          node.send([null, newmsg]);
      };
      
      this.suberror = function(qos){
          node.subscribedqos = qos;
          node.showandsendstate();
      };
  }
  
  RED.nodes.registerType("mqtt-plus in",MQTTInNode);

  function MQTTOutNode(n) {
      RED.nodes.createNode(this,n);
      this.topic = n.topic;
      this.qos = n.qos || null;
      this.retain = n.retain;
      this.broker = n.broker;
      this.brokerConn = RED.nodes.getNode(this.broker);
      var node = this;

      if (this.brokerConn) {
          this.status({fill:"red",shape:"ring",text:"node-red:common.status.disconnected"});
          this.on("input",(msg)=>{
              // if msg contains 'username' or 'password, change credentials and leave
              if (msg.username !== undefined || msg.password !== undefined){
                  console.log("u:" + msg.username + " p:"+msg.password);
                  this.brokerConn.changecredentials(msg.username, msg.password);
                  return;
              }
              
              if (msg.cmd === 'getconnected'){
                  this.onconnect();
                  return;
              }
              
              if (msg.qos) {
                  msg.qos = parseInt(msg.qos);
                  if ((msg.qos !== 0) && (msg.qos !== 1) && (msg.qos !== 2)) {
                      msg.qos = null;
                  }
              }
              msg.qos = Number(node.qos || msg.qos || 0);
              msg.retain = node.retain || msg.retain || false;
              msg.retain = ((msg.retain === true) || (msg.retain === "true")) || false;
              if (node.topic) {
                  msg.topic = node.topic;
              }
              if ( msg.hasOwnProperty("payload")) {
                  if (msg.hasOwnProperty("topic") && (typeof msg.topic === "string") && (msg.topic !== "")) { // topic must exist
                      this.brokerConn.publish(msg, this);  // send the message
                  }
                  else { node.warn(RED._("mqtt.errors.invalid-topic")); }
              }
          });
          if (this.brokerConn.connected) {
              this.onconnect();
              //node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
          }
          node.brokerConn.register(node);
          this.on('close', function(done) {
              node.brokerConn.deregister(node,done);
          });
      } else {
          this.error(RED._("mqtt.errors.missing-config"));
      }

      this.onconnect = function () {
          if (this.brokerConn.connected) {
              node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
              var newmsg = {
                  connected:true,
                  topic: node.topic
              };
              node.send(newmsg);
          } else {
              node.status({fill:"red",shape:"ring",text:"node-red:common.status.disconnected"});
              var newmsg = {
                  connected:false,
                  topic: node.topic
              };
              node.send(newmsg);
          }
      };
      
      this.ondisconnect = this.onconnect;
      this.onreconnecting = function(){
          node.status({fill:"yellow",shape:"ring",text:"node-red:common.status.connecting"});
          var newmsg = {
              connected:false,
              reconnecting: true,
              topic: node.topic
          };
          node.send(newmsg);
      };
  }
  
  RED.nodes.registerType("mqtt-plus out",MQTTOutNode);
};
