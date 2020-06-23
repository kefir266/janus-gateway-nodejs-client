const janus = require('./src/janus');

function Janus(server) {
  const that = this;
  return  new Promise((resolve, error) => {
    this.janusConnector = new janus({
      server,
      success() {
        return resolve(that); },
      error,
    })
  });
}

Janus.prototype.attach = function attach(plugin) {
  const that = this;
  this.name = plugin.name;
  return new Promise((resolve, error) => {
    const pluginObj = Object.assign(plugin, {
      opaqueId: plugin.name + janus.randomString(12),
      success(pluginHandle) {
        that.pluginHandle = pluginHandle;
        janus.log(`Plugin attached! (${pluginHandle.getPlugin()}, id=${pluginHandle.getId()})`);
        resolve({ janusLib: janus, pluginHandle });
      },
      error,
    })
    this.janusConnector.attach(pluginObj);
  });
}

Janus.prototype.join = function join(roomId) {
  const register = {
    request: 'join', room: roomId, ptype: 'publisher', display: this.name,
  };
  this.pluginHandle.send({
    message: register,
    success: (res) => {
      janus.log('Register publisher', res);
    },
    error(err) {
      janus.log('Error joining room', err);
    },
  });
}

module.exports = Janus;
