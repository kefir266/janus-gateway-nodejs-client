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
  return new Promise((resolve, error) => {
    const pluginObj = Object.assign(plugin, {
      opaqueId: plugin.name + janus.randomString(12),
      success(pluginHandle) {
        janus.log(`Plugin attached! (${pluginHandle.getPlugin()}, id=${pluginHandle.getId()})`);
        resolve({ janus, pluginHandle });
      },
      error,
    })
    this.janusConnector.attach(pluginObj);
  });

}

module.exports = Janus;
