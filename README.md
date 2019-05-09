# node-red-contrib-mqtt-plus
A few enhancements on top of the standard MQTT node set


## Additional Features

Both the input and output node have an input and an output.


### mqtt-plus in
messages can be sent into the new input of this node to select a new subscription.

msg = { cmd: 'subscribe', topic: 'new/topic' }

will change the subscription to 'new/topic'.

msg = { cmd: 'resubscribe' }

will force the node to re-subscribe to the current topic (for example, if previously it was not authorised, and now it is).

msg = { cmd: 'getconnected' }

will cause a message to be sent indicating the subscription state, connection state, and QOS of the current subscription; like:

msg = { subscribed: true|false, connected: true|false, qos: 0|1|2|128 }

(128 indicates error).

The node will produce the same messages on connection, disconnection, and subscription change.

The visual node status will indicate the current subscriptions QOS, or 'disconnected'.


### mqtt-plus out
messages can be sent into the input of this node to select request conection information.

msg = { cmd: 'getconnected' }

will cause a message to be sent indicating the connection state; like:

msg = { connected: true|false }

The node will produce the same messages on connection, and disconnection of the mqtt-plus-broker config node from the actual broker.


### mqtt-plus-broker - configuration node
This has the same basic behavious as the original mqtt-broker node, just with operational modifications to support the above functionality.


## Change Log
### 0.0.5
* add use of process.env.http_proxy as per latest NR repo mods.
* add use of process.env.no_proxy - NR does not have this yet.
### 0.0.4
* fixes a crash when a subscribe fails due to invalid topic name/structure
### 0.0.3
* tweaks to output messages, introduction of 2nd out on mqtt-plus in, and updates to html descriptions
### 0.0.2
* updates with new functionality
### 0.0.1
* duplicate of std mqtt node set
