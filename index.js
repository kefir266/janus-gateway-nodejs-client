const janus = require('./src/janus');

function Janus(options) {
  const that = this;
  this.server = options.server;
  this.debug = options.debug || 'error';
  return new Promise((resolve, error) => {
    const intervalID = setInterval(() => {
      this.connect(() => {
        clearInterval(intervalID);
        resolve(that);
      })
    }, 1000)
  });
}

Janus.prototype.connect = function connect(success) {
  this.janusConnector = new janus({
    server: this.server,
    debug: this.debug,
    success,
    error(err) {
      console.log(err);
    },
  })
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
  return new Promise((resolve, reject) => {
    const register = {
      request: 'join', room: roomId, ptype: 'publisher', display: this.name,
    };
    this.pluginHandle.send({
      message: register,
      success: () => {
        janus.log('Register publisher', register);
        resolve();
      },
      error(err) {
        janus.log('Error joining room', err);
        reject(err);
      },
    });
  });

}

module.exports = Janus;
