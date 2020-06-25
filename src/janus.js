const axios = require('axios');
const WebSocket = require('ws');
const wrtc = require('electron-webrtc')();

const adapter = Janus.noop;

// List of sessions
Janus.sessions = {};

Janus.isExtensionEnabled = function () {
  if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
    // No need for the extension, getDisplayMedia is supported
    return true;
  }
  if (window.navigator.userAgent.match('Chrome')) {
    const chromever = parseInt(window.navigator.userAgent.match(/Chrome\/(.*) /)[1], 10);
    let maxver = 33;
    if (window.navigator.userAgent.match('Linux')) {
      maxver = 35;
    }	// "known" crash in chrome 34 and 35 on linux
    if (chromever >= 26 && chromever <= maxver) {
      // Older versions of Chrome don't support this extension-based approach, so lie
      return true;
    }
    return Janus.extension.isInstalled();
  }
  // Firefox of others, no need for the extension (but this doesn't mean it will work)
  return true;
};

const defaultExtension = {
  // Screensharing Chrome Extension ID
  extensionId: 'hapfgfdkleiggjjpfpenajgdnfckjpaj',
  isInstalled() {
    return document.querySelector('#janus-extension-installed') !== null;
  },
  getScreen(callback) {
    const pending = window.setTimeout(() => {
      const error = new Error('NavigatorUserMediaError');
      error.name = 'The required Chrome extension is not installed: click <a href="#">here</a> to install it. (NOTE: this will need you to refresh the page)';
      return callback(error);
    }, 1000);
    this.cache[pending] = callback;
    window.postMessage({ type: 'janusGetScreen', id: pending }, '*');
  },
  init() {
    const cache = {};
    this.cache = cache;
    // Wait for events from the Chrome Extension
    window.addEventListener('message', (event) => {
      if (event.origin != window.location.origin) {
        return;
      }
      if (event.data.type == 'janusGotScreen' && cache[event.data.id]) {
        const callback = cache[event.data.id];
        delete cache[event.data.id];

        if (event.data.sourceId === '') {
          // user canceled
          const error = new Error('NavigatorUserMediaError');
          error.name = 'You cancelled the request for permission, giving up...';
          callback(error);
        } else {
          callback(null, event.data.sourceId);
        }
      } else if (event.data.type == 'janusGetScreenPending') {
        console.log('clearing ', event.data.id);
        window.clearTimeout(event.data.id);
      }
    });
  },
};

Janus.useDefaultDependencies = function (deps) {
  const f = (deps && deps.fetch) || axios;
  const p = (deps && deps.Promise) || Promise;
  const socketCls = (deps && deps.WebSocket) || WebSocket;

  return {
    newWebSocket(server, proto) {
      return new socketCls(server, proto);
    },
    // extension: (deps && deps.extension) || defaultExtension,
    isArray(arr) {
      return Array.isArray(arr);
    },
    webRTCAdapter: (deps && deps.adapter) || adapter,
    httpAPICall(url, options) {
      const req = {
        method: options.verb,
        url,
        data: options.body,
        headers: {
          Accept: 'application/json, text/plain, */*',
        },
        cache: 'no-cache',
      };
      if (options.verb === 'POST') {
        req.headers['Content-Type'] = 'application/json';
      }
      if (options.withCredentials !== undefined) {
        req.credentials = options.withCredentials === true ? 'include' : (options.withCredentials ? options.withCredentials : 'omit');
      }


      let fetching = f(req).catch(error => p.reject({
        message: 'Probably a network error, is the server down?',
        error
      }));


      if (options.timeout) {
        const timeout = new p(((resolve, reject) => {
          const timerId = setTimeout(() => {
            clearTimeout(timerId);
            return reject({ message: 'Request timed out', timeout: options.timeout });
          }, options.timeout);
        }));
        fetching = p.race([fetching, timeout]);
      }

      fetching.then((response) => {
        if (response.status === 200) {
          if (typeof (options.success) === typeof (Janus.noop)) {
            options.success(response.data);
            return response;
          }
        } else {
          return p.reject({ message: 'API call failed', response });
        }
      }).catch((error) => {
        if (typeof (options.error) === typeof (Janus.noop)) {
          options.error(error.message || '<< internal error >>', error);
        }
      });

      return fetching;
    },
  };
};

Janus.useOldDependencies = function (deps) {
  const jq = (deps && deps.jQuery) || jQuery;
  const socketCls = (deps && deps.WebSocket) || WebSocket;
  return {
    newWebSocket(server, proto) {
      return new socketCls(server, proto);
    },
    isArray(arr) {
      return jq.isArray(arr);
    },
    extension: (deps && deps.extension) || defaultExtension,
    webRTCAdapter: (deps && deps.adapter) || adapter,
    httpAPICall(url, options) {
      const payload = options.body !== undefined ? {
        contentType: 'application/json',
        data: JSON.stringify(options.body),
      } : {};
      const credentials = options.withCredentials !== undefined ? { xhrFields: { withCredentials: options.withCredentials } } : {};

      return jq.ajax(jq.extend(payload, credentials, {
        url,
        type: options.verb,
        cache: false,
        dataType: 'json',
        async: options.async,
        timeout: options.timeout,
        success(result) {
          if (typeof (options.success) === typeof (Janus.noop)) {
            options.success(result);
          }
        },
        error(xhr, status, err) {
          if (typeof (options.error) === typeof (Janus.noop)) {
            options.error(status, err);
          }
        },
      }));
    },
  };
};

Janus.noop = function () {
};

Janus.dataChanDefaultLabel = 'JanusDataChannel';

// Note: in the future we may want to change this, e.g., as was
// attempted in https://github.com/meetecho/janus-gateway/issues/1670
Janus.endOfCandidates = null;

// Initialization
Janus.init = function (options) {
  options = options || {};
  options.callback = (typeof options.callback === 'function') ? options.callback : Janus.noop;
  if (Janus.initDone) {
    // Already initialized
    options.callback();
  } else {
    if (typeof console === 'undefined' || typeof console.log === 'undefined') {
      console = {
        log() {
        },
      };
    }
    // Console logging (all debugging disabled by default)
    Janus.trace = Janus.noop;
    Janus.debug = Janus.noop;
    Janus.vdebug = Janus.noop;
    Janus.log = Janus.noop;
    Janus.warn = Janus.noop;
    Janus.error = Janus.noop;
    if (options.debug === true || options.debug === 'all') {
      // Enable all debugging levels
      Janus.trace = console.trace.bind(console);
      Janus.debug = console.debug.bind(console);
      Janus.vdebug = console.debug.bind(console);
      Janus.log = console.log.bind(console);
      Janus.warn = console.warn.bind(console);
      Janus.error = console.error.bind(console);
    } else if (Array.isArray(options.debug)) {
      for (const d of options.debug) {
        switch (d) {
          case 'trace':
            Janus.trace = console.trace.bind(console);
            break;
          case 'debug':
            Janus.debug = console.debug.bind(console);
            break;
          case 'vdebug':
            Janus.vdebug = console.debug.bind(console);
            break;
          case 'log':
            Janus.log = console.log.bind(console);
            break;
          case 'warn':
            Janus.warn = console.warn.bind(console);
            break;
          case 'error':
            Janus.error = console.error.bind(console);
            break;
          default:
            console.error(`Unknown debugging option '${d}' (supported: 'trace', 'debug', 'vdebug', 'log', warn', 'error')`);
            break;
        }
      }
    }
    Janus.log('Initializing library');

    const usedDependencies = options.dependencies || Janus.useDefaultDependencies();
    Janus.isArray = usedDependencies.isArray;
    Janus.webRTCAdapter = usedDependencies.webRTCAdapter;
    Janus.httpAPICall = usedDependencies.httpAPICall;
    Janus.newWebSocket = usedDependencies.newWebSocket;
    // Janus.extension = usedDependencies.extension;
    // Janus.extension.init();

    // Helper method to enumerate devices
    Janus.listDevices = function (callback, config) {
      callback = (typeof callback === 'function') ? callback : Janus.noop;
      if (config == null) config = { audio: true, video: true };
      if (Janus.isGetUserMediaAvailable()) {
        navigator.mediaDevices.getUserMedia(config)
          .then((stream) => {
            navigator.mediaDevices.enumerateDevices().then((devices) => {
              Janus.debug(devices);
              callback(devices);
              // Get rid of the now useless stream
              try {
                const tracks = stream.getTracks();
                for (const mst of tracks) {
                  if (mst) {
                    mst.stop();
                  }
                }
              } catch (e) {
              }
            });
          })
          .catch((err) => {
            Janus.error(err);
            callback([]);
          });
      } else {
        Janus.warn('navigator.mediaDevices unavailable');
        callback([]);
      }
    };
    // Helper methods to attach/reattach a stream to a video element (previously part of adapter.js)
    Janus.attachMediaStream = function (element, stream) {
      try {
        element.srcObject = stream;
      } catch (e) {
        try {
          element.src = URL.createObjectURL(stream);
        } catch (e) {
          Janus.error('Error attaching stream to element');
        }
      }
    };
    Janus.reattachMediaStream = function (to, from) {
      try {
        to.srcObject = from.srcObject;
      } catch (e) {
        try {
          to.src = from.src;
        } catch (e) {
          Janus.error('Error reattaching stream to element');
        }
      }
    };

    Janus.initDone = true;
    options.callback();
  }
};

// Helper method to check whether WebRTC is supported by this browser
Janus.isWebrtcSupported = function () {
  return true;
};
// Helper method to check whether devices can be accessed by this browser (e.g., not possible via plain HTTP)
Janus.isGetUserMediaAvailable = function () {
  return !!((navigator.mediaDevices && navigator.mediaDevices.getUserMedia));
};

// Helper method to create random identifiers (e.g., transaction)
Janus.randomString = function (len) {
  const charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let randomString = '';
  for (let i = 0; i < len; i++) {
    const randomPoz = Math.floor(Math.random() * charSet.length);
    randomString += charSet.substring(randomPoz, randomPoz + 1);
  }
  return randomString;
};


function Janus(gatewayCallbacks) {
  Janus.createDataChannel = createDataChannel;
  if (!Janus.initDone) {
    gatewayCallbacks.error('Library not initialized');
    return {};
  }
  if (!Janus.isWebrtcSupported()) {
    gatewayCallbacks.error('WebRTC not supported by this browser');
    return {};
  }
  Janus.log(`Library initialized: ${Janus.initDone}`);
  gatewayCallbacks = gatewayCallbacks || {};
  gatewayCallbacks.success = (typeof gatewayCallbacks.success === 'function') ? gatewayCallbacks.success : Janus.noop;
  gatewayCallbacks.error = (typeof gatewayCallbacks.error === 'function') ? gatewayCallbacks.error : Janus.noop;
  gatewayCallbacks.destroyed = (typeof gatewayCallbacks.destroyed === 'function') ? gatewayCallbacks.destroyed : Janus.noop;
  if (!gatewayCallbacks.server) {
    gatewayCallbacks.error('Invalid server url');
    return {};
  }
  let websockets = false;
  let ws = null;
  let wsHandlers = {};
  let wsKeepaliveTimeoutId = null;

  let servers = null,
    serversIndex = 0;
  let server = gatewayCallbacks.server;
  if (Janus.isArray(server)) {
    Janus.log(`Multiple servers provided (${server.length}), will use the first that works`);
    server = null;
    servers = gatewayCallbacks.server;
    Janus.debug(servers);
  } else if (server.indexOf('ws') === 0) {
    websockets = true;
    Janus.log(`Using WebSockets to contact Janus: ${server}`);
  } else {
    websockets = false;
    Janus.log(`Using REST API to contact Janus: ${server}`);
  }
  const iceServers = gatewayCallbacks.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];
  const iceTransportPolicy = gatewayCallbacks.iceTransportPolicy;
  const bundlePolicy = gatewayCallbacks.bundlePolicy;
  // Whether IPv6 candidates should be gathered
  const ipv6Support = (gatewayCallbacks.ipv6 === true);
  // Whether we should enable the withCredentials flag for XHR requests
  let withCredentials = false;
  if (gatewayCallbacks.withCredentials !== undefined && gatewayCallbacks.withCredentials !== null) {
    withCredentials = gatewayCallbacks.withCredentials === true;
  }
  // Optional max events
  let maxev = 10;
  if (gatewayCallbacks.max_poll_events !== undefined && gatewayCallbacks.max_poll_events !== null) {
    maxev = gatewayCallbacks.max_poll_events;
  }
  if (maxev < 1) {
    maxev = 1;
  }
  // Token to use (only if the token based authentication mechanism is enabled)
  let token = null;
  if (gatewayCallbacks.token !== undefined && gatewayCallbacks.token !== null) {
    token = gatewayCallbacks.token;
  }
  // API secret to use (only if the shared API secret is enabled)
  let apisecret = null;
  if (gatewayCallbacks.apisecret !== undefined && gatewayCallbacks.apisecret !== null) {
    apisecret = gatewayCallbacks.apisecret;
  }
  // Whether we should destroy this session when onbeforeunload is called
  this.destroyOnUnload = true;
  if (gatewayCallbacks.destroyOnUnload !== undefined && gatewayCallbacks.destroyOnUnload !== null) {
    this.destroyOnUnload = (gatewayCallbacks.destroyOnUnload === true);
  }
  // Some timeout-related values
  let keepAlivePeriod = 25000;
  if (gatewayCallbacks.keepAlivePeriod !== undefined && gatewayCallbacks.keepAlivePeriod !== null) {
    keepAlivePeriod = gatewayCallbacks.keepAlivePeriod;
  }
  if (isNaN(keepAlivePeriod)) {
    keepAlivePeriod = 25000;
  }
  let longPollTimeout = 60000;
  if (gatewayCallbacks.longPollTimeout !== undefined && gatewayCallbacks.longPollTimeout !== null) {
    longPollTimeout = gatewayCallbacks.longPollTimeout;
  }
  if (isNaN(longPollTimeout)) {
    longPollTimeout = 60000;
  }

  // overrides for default maxBitrate values for simulcasting
  function getMaxBitrates(simulcastMaxBitrates) {
    const maxBitrates = {
      high: 900000,
      medium: 300000,
      low: 100000,
    };

    if (simulcastMaxBitrates !== undefined && simulcastMaxBitrates !== null) {
      if (simulcastMaxBitrates.high) {
        maxBitrates.high = simulcastMaxBitrates.high;
      }
      if (simulcastMaxBitrates.medium) {
        maxBitrates.medium = simulcastMaxBitrates.medium;
      }
      if (simulcastMaxBitrates.low) {
        maxBitrates.low = simulcastMaxBitrates.low;
      }
    }

    return maxBitrates;
  }

  let connected = false;
  let sessionId = null;
  const pluginHandles = {};
  const that = this;
  let retries = 0;
  const transactions = {};
  createSession(gatewayCallbacks);

  // Public methods
  this.getServer = function () {
    return server;
  };
  this.isConnected = function () {
    return connected;
  };
  this.reconnect = function (callbacks) {
    callbacks = callbacks || {};
    callbacks.success = (typeof callbacks.success === 'function') ? callbacks.success : Janus.noop;
    callbacks.error = (typeof callbacks.error === 'function') ? callbacks.error : Janus.noop;
    callbacks.reconnect = true;
    createSession(callbacks);
  };
  this.getSessionId = function () {
    return sessionId;
  };
  this.destroy = function (callbacks) {
    destroySession(callbacks);
  };
  this.attach = function (callbacks) {
    createHandle(callbacks);
  };

  function eventHandler() {
    if (sessionId == null) {
      return;
    }
    Janus.debug('Long poll...');
    if (!connected) {
      Janus.warn('Is the server down? (connected=false)');
      return;
    }
    let longpoll = `${server}/${sessionId}?rid=${new Date().getTime()}`;
    if (maxev) {
      longpoll = `${longpoll}&maxev=${maxev}`;
    }
    if (token) {
      longpoll = `${longpoll}&token=${encodeURIComponent(token)}`;
    }
    if (apisecret) {
      longpoll = `${longpoll}&apisecret=${encodeURIComponent(apisecret)}`;
    }
    Janus.httpAPICall(longpoll, {
      verb: 'GET',
      withCredentials,
      success: handleEvent,
      timeout: longPollTimeout,
      error(textStatus, errorThrown) {
        Janus.error(`${textStatus}:`, errorThrown);
        retries++;
        if (retries > 3) {
          // Did we just lose the server? :-(
          connected = false;
          gatewayCallbacks.error('Lost connection to the server (is it down?)');
          return;
        }
        eventHandler();
      },
    });
  }

  // Private event handler: this will trigger plugin callbacks, if set
  function handleEvent(json, skipTimeout) {
    retries = 0;
    if (!websockets && sessionId !== undefined && sessionId !== null && skipTimeout !== true) {
      eventHandler();
    }
    if (!websockets && Janus.isArray(json)) {
      // We got an array: it means we passed a maxev > 1, iterate on all objects
      for (let i = 0; i < json.length; i++) {
        handleEvent(json[i], true);
      }
      return;
    }
    if (json.janus === 'keepalive') {
      // Nothing happened
      Janus.vdebug(`Got a keepalive on session ${sessionId}`);
    } else if (json.janus === 'ack') {
      // Just an ack, we can probably ignore
      Janus.debug(`Got an ack on session ${sessionId}`);
      Janus.debug(json);
      var transaction = json.transaction;
      if (transaction) {
        var reportSuccess = transactions[transaction];
        if (reportSuccess) {
          reportSuccess(json);
        }
        delete transactions[transaction];
      }
    } else if (json.janus === 'success') {
      // Success!
      Janus.debug(`Got a success on session ${sessionId}`);
      Janus.debug(json);
      var transaction = json.transaction;
      if (transaction) {
        var reportSuccess = transactions[transaction];
        if (reportSuccess) {
          reportSuccess(json);
        }
        delete transactions[transaction];
      }
    } else if (json.janus === 'trickle') {
      // We got a trickle candidate from Janus
      var sender = json.sender;
      if (!sender) {
        Janus.warn('Missing sender...');
        return;
      }
      var pluginHandle = pluginHandles[sender];
      if (!pluginHandle) {
        Janus.debug('This handle is not attached to this session');
        return;
      }
      const candidate = json.candidate;
      Janus.debug(`Got a trickled candidate on session ${sessionId}`);
      Janus.debug(candidate);
      const config = pluginHandle.webrtcStuff;
      if (config.pc && config.remoteSdp) {
        // Add candidate right now
        Janus.debug('Adding remote candidate:', candidate);
        if (!candidate || candidate.completed === true) {
          // end-of-candidates
          config.pc.addIceCandidate(Janus.endOfCandidates);
        } else {
          // New candidate
          config.pc.addIceCandidate(candidate);
        }
      } else {
        // We didn't do setRemoteDescription (trickle got here before the offer?)
        Janus.debug("We didn't do setRemoteDescription (trickle got here before the offer?), caching candidate");
        if (!config.candidates) {
          config.candidates = [];
        }
        config.candidates.push(candidate);
        Janus.debug(config.candidates);
      }
    } else if (json.janus === 'webrtcup') {
      // The PeerConnection with the server is up! Notify this
      Janus.debug(`Got a webrtcup event on session ${sessionId}`);
      Janus.debug(json);
      var sender = json.sender;
      if (!sender) {
        Janus.warn('Missing sender...');
        return;
      }
      var pluginHandle = pluginHandles[sender];
      if (!pluginHandle) {
        Janus.debug('This handle is not attached to this session');
        return;
      }
      pluginHandle.webrtcState(true);
    } else if (json.janus === 'hangup') {
      // A plugin asked the core to hangup a PeerConnection on one of our handles
      Janus.debug(`Got a hangup event on session ${sessionId}`);
      Janus.debug(json);
      var sender = json.sender;
      if (!sender) {
        Janus.warn('Missing sender...');
        return;
      }
      var pluginHandle = pluginHandles[sender];
      if (!pluginHandle) {
        Janus.debug('This handle is not attached to this session');
        return;
      }
      pluginHandle.webrtcState(false, json.reason);
      pluginHandle.hangup();
    } else if (json.janus === 'detached') {
      // A plugin asked the core to detach one of our handles
      Janus.debug(`Got a detached event on session ${sessionId}`);
      Janus.debug(json);
      var sender = json.sender;
      if (!sender) {
        Janus.warn('Missing sender...');
        return;
      }
      var pluginHandle = pluginHandles[sender];
      if (!pluginHandle) {
        // Don't warn here because destroyHandle causes this situation.
        return;
      }
      pluginHandle.detached = true;
      pluginHandle.ondetached();
      pluginHandle.detach();
    } else if (json.janus === 'media') {
      // Media started/stopped flowing
      Janus.debug(`Got a media event on session ${sessionId}`);
      Janus.debug(json);
      var sender = json.sender;
      if (!sender) {
        Janus.warn('Missing sender...');
        return;
      }
      var pluginHandle = pluginHandles[sender];
      if (!pluginHandle) {
        Janus.debug('This handle is not attached to this session');
        return;
      }
      pluginHandle.mediaState(json.type, json.receiving);
    } else if (json.janus === 'slowlink') {
      Janus.debug(`Got a slowlink event on session ${sessionId}`);
      Janus.debug(json);
      // Trouble uplink or downlink
      var sender = json.sender;
      if (!sender) {
        Janus.warn('Missing sender...');
        return;
      }
      var pluginHandle = pluginHandles[sender];
      if (!pluginHandle) {
        Janus.debug('This handle is not attached to this session');
        return;
      }
      pluginHandle.slowLink(json.uplink, json.lost);
    } else if (json.janus === 'error') {
      // Oops, something wrong happened
      Janus.error(`Ooops: ${json.error.code} ${json.error.reason}`);	// FIXME
      Janus.debug(json);
      var transaction = json.transaction;
      if (transaction) {
        var reportSuccess = transactions[transaction];
        if (reportSuccess) {
          reportSuccess(json);
        }
        delete transactions[transaction];
      }
    } else if (json.janus === 'event') {
      Janus.debug(`Got a plugin event on session ${sessionId}`);
      Janus.debug(json);
      var sender = json.sender;
      if (!sender) {
        Janus.warn('Missing sender...');
        return;
      }
      const plugindata = json.plugindata;
      if (!plugindata) {
        Janus.warn('Missing plugindata...');
        return;
      }
      Janus.debug(`  -- Event is coming from ${sender} (${plugindata.plugin})`);
      const data = plugindata.data;
      Janus.debug(data);
      var pluginHandle = pluginHandles[sender];
      if (!pluginHandle) {
        Janus.warn('This handle is not attached to this session');
        return;
      }
      const jsep = json.jsep;
      if (jsep) {
        Janus.debug('Handling SDP as well...');
        Janus.debug(jsep);
      }
      const callback = pluginHandle.onmessage;
      if (callback) {
        Janus.debug('Notifying application...');
        // Send to callback specified when attaching plugin handle
        callback(data, jsep);
      } else {
        // Send to generic callback (?)
        Janus.debug('No provided notification callback');
      }
    } else if (json.janus === 'timeout') {
      Janus.error(`Timeout on session ${sessionId}`);
      Janus.debug(json);
      if (websockets) {
        ws.close(3504, 'Gateway timeout');
      }
    } else {
      Janus.warn(`Unknown message/event  '${json.janus}' on session ${sessionId}`);
      Janus.debug(json);
    }
  }

  // Private helper to send keep-alive messages on WebSockets
  function keepAlive() {
    if (!server || !websockets || !connected) {
      return;
    }
    wsKeepaliveTimeoutId = setTimeout(keepAlive, keepAlivePeriod);
    const request = { janus: 'keepalive', session_id: sessionId, transaction: Janus.randomString(12) };
    if (token) {
      request.token = token;
    }
    if (apisecret) {
      request.apisecret = apisecret;
    }
    ws.send(JSON.stringify(request));
  }

  // Private method to create a session
  function createSession(callbacks) {
    const transaction = Janus.randomString(12);
    const request = { janus: 'create', transaction };
    if (callbacks.reconnect) {
      // We're reconnecting, claim the session
      connected = false;
      request.janus = 'claim';
      request.session_id = sessionId;
      // If we were using websockets, ignore the old connection
      if (ws) {
        ws.onopen = null;
        ws.onerror = null;
        ws.onclose = null;
        if (wsKeepaliveTimeoutId) {
          clearTimeout(wsKeepaliveTimeoutId);
          wsKeepaliveTimeoutId = null;
        }
      }
    }
    if (token) {
      request.token = token;
    }
    if (apisecret) {
      request.apisecret = apisecret;
    }
    if (!server && Janus.isArray(servers)) {
      // We still need to find a working server from the list we were given
      server = servers[serversIndex];
      if (server.indexOf('ws') === 0) {
        websockets = true;
        Janus.log(`Server #${serversIndex + 1}: trying WebSockets to contact Janus (${server})`);
      } else {
        websockets = false;
        Janus.log(`Server #${serversIndex + 1}: trying REST API to contact Janus (${server})`);
      }
    }
    if (websockets) {
      ws = Janus.newWebSocket(server, 'janus-protocol');
      wsHandlers = {
        error() {
          Janus.error(`Error connecting to the Janus WebSockets server... ${server}`);
          if (Janus.isArray(servers) && !callbacks.reconnect) {
            serversIndex++;
            if (serversIndex == servers.length) {
              // We tried all the servers the user gave us and they all failed
              callbacks.error('Error connecting to any of the provided Janus servers: Is the server down?');
              return;
            }
            // Let's try the next server
            server = null;
            setTimeout(() => {
              createSession(callbacks);
            }, 200);
            return;
          }
          callbacks.error('Error connecting to the Janus WebSockets server: Is the server down?');
        },

        open() {
          // We need to be notified about the success
          transactions[transaction] = function (json) {
            Janus.debug(json);
            if (json.janus !== 'success') {
              Janus.error(`Ooops: ${json.error.code} ${json.error.reason}`);	// FIXME
              callbacks.error(json.error.reason);
              return;
            }
            wsKeepaliveTimeoutId = setTimeout(keepAlive, keepAlivePeriod);
            connected = true;
            sessionId = json.session_id ? json.session_id : json.data.id;
            if (callbacks.reconnect) {
              Janus.log(`Claimed session: ${sessionId}`);
            } else {
              Janus.log(`Created session: ${sessionId}`);
            }
            Janus.sessions[sessionId] = that;
            callbacks.success();
          };
          ws.send(JSON.stringify(request));
        },

        message(event) {
          handleEvent(JSON.parse(event.data));
        },

        close() {
          if (!server || !connected) {
            return;
          }
          connected = false;
          // FIXME What if this is called when the page is closed?
          gatewayCallbacks.error('Lost connection to the server (is it down?)');
        },
      };

      for (const eventName in wsHandlers) {
        ws.addEventListener(eventName, wsHandlers[eventName]);
      }

      return;
    }
    Janus.httpAPICall(server, {
      verb: 'POST',
      withCredentials,
      body: request,
      success(json) {
        Janus.debug(json);
        if (json.janus !== 'success') {
          Janus.error(`Ooops: ${json.error.code} ${json.error.reason}`);	// FIXME
          callbacks.error(json.error.reason);
          return;
        }
        connected = true;
        sessionId = json.session_id ? json.session_id : json.data.id;
        if (callbacks.reconnect) {
          Janus.log(`Claimed session: ${sessionId}`);
        } else {
          Janus.log(`Created session: ${sessionId}`);
        }
        Janus.sessions[sessionId] = that;
        eventHandler();
        callbacks.success();
      },
      error(textStatus, errorThrown) {
        Janus.error(`${textStatus}:`, errorThrown);	// FIXME
        if (Janus.isArray(servers) && !callbacks.reconnect) {
          serversIndex++;
          if (serversIndex == servers.length) {
            // We tried all the servers the user gave us and they all failed
            callbacks.error('Error connecting to any of the provided Janus servers: Is the server down?');
            return;
          }
          // Let's try the next server
          server = null;
          setTimeout(() => {
            createSession(callbacks);
          }, 200);
          return;
        }
        if (errorThrown === '') {
          callbacks.error(`${textStatus}: Is the server down?`);
        } else {
          callbacks.error(`${textStatus}: ${errorThrown}`);
        }
      },
    });
  }

  // Private method to destroy a session
  function destroySession(callbacks) {
    callbacks = callbacks || {};
    // FIXME This method triggers a success even when we fail
    callbacks.success = (typeof callbacks.success === 'function') ? callbacks.success : Janus.noop;
    let asyncRequest = true;
    if (callbacks.asyncRequest !== undefined && callbacks.asyncRequest !== null) {
      asyncRequest = (callbacks.asyncRequest === true);
    }
    let notifyDestroyed = true;
    if (callbacks.notifyDestroyed !== undefined && callbacks.notifyDestroyed !== null) {
      notifyDestroyed = (callbacks.notifyDestroyed === true);
    }
    let cleanupHandles = false;
    if (callbacks.cleanupHandles !== undefined && callbacks.cleanupHandles !== null) {
      cleanupHandles = (callbacks.cleanupHandles === true);
    }
    Janus.log(`Destroying session ${sessionId} (async=${asyncRequest})`);
    if (!sessionId) {
      Janus.warn('No session to destroy');
      callbacks.success();
      if (notifyDestroyed) {
        gatewayCallbacks.destroyed();
      }
      return;
    }
    if (cleanupHandles) {
      for (const handleId in pluginHandles) {
        destroyHandle(handleId, { noRequest: true });
      }
    }
    if (!connected) {
      Janus.warn('Is the server down? (connected=false)');
      callbacks.success();
      return;
    }
    // No need to destroy all handles first, Janus will do that itself
    const request = { janus: 'destroy', transaction: Janus.randomString(12) };
    if (token) {
      request.token = token;
    }
    if (apisecret) {
      request.apisecret = apisecret;
    }
    if (websockets) {
      request.session_id = sessionId;

      const unbindWebSocket = function () {
        for (const eventName in wsHandlers) {
          ws.removeEventListener(eventName, wsHandlers[eventName]);
        }
        ws.removeEventListener('message', onUnbindMessage);
        ws.removeEventListener('error', onUnbindError);
        if (wsKeepaliveTimeoutId) {
          clearTimeout(wsKeepaliveTimeoutId);
        }
        ws.close();
      };

      var onUnbindMessage = function (event) {
        const data = JSON.parse(event.data);
        if (data.session_id == request.session_id && data.transaction == request.transaction) {
          unbindWebSocket();
          callbacks.success();
          if (notifyDestroyed) {
            gatewayCallbacks.destroyed();
          }
        }
      };
      var onUnbindError = function (event) {
        unbindWebSocket();
        callbacks.error('Failed to destroy the server: Is the server down?');
        if (notifyDestroyed) {
          gatewayCallbacks.destroyed();
        }
      };

      ws.addEventListener('message', onUnbindMessage);
      ws.addEventListener('error', onUnbindError);

      ws.send(JSON.stringify(request));
      return;
    }
    Janus.httpAPICall(`${server}/${sessionId}`, {
      verb: 'POST',
      async: asyncRequest,	// Sometimes we need false here, or destroying in onbeforeunload won't work
      withCredentials,
      body: request,
      success(json) {
        Janus.log('Destroyed session:');
        Janus.debug(json);
        sessionId = null;
        connected = false;
        if (json.janus !== 'success') {
          Janus.error(`Ooops: ${json.error.code} ${json.error.reason}`);	// FIXME
        }
        callbacks.success();
        if (notifyDestroyed) {
          gatewayCallbacks.destroyed();
        }
      },
      error(textStatus, errorThrown) {
        Janus.error(`${textStatus}:`, errorThrown);	// FIXME
        // Reset everything anyway
        sessionId = null;
        connected = false;
        callbacks.success();
        if (notifyDestroyed) {
          gatewayCallbacks.destroyed();
        }
      },
    });
  }

  // Private method to create a plugin handle
  function createHandle(callbacks) {
    callbacks = callbacks || {};
    callbacks.success = (typeof callbacks.success === 'function') ? callbacks.success : Janus.noop;
    callbacks.error = (typeof callbacks.error === 'function') ? callbacks.error : Janus.noop;
    callbacks.consentDialog = (typeof callbacks.consentDialog === 'function') ? callbacks.consentDialog : Janus.noop;
    callbacks.iceState = (typeof callbacks.iceState === 'function') ? callbacks.iceState : Janus.noop;
    callbacks.mediaState = (typeof callbacks.mediaState === 'function') ? callbacks.mediaState : Janus.noop;
    callbacks.webrtcState = (typeof callbacks.webrtcState === 'function') ? callbacks.webrtcState : Janus.noop;
    callbacks.slowLink = (typeof callbacks.slowLink === 'function') ? callbacks.slowLink : Janus.noop;
    callbacks.onmessage = (typeof callbacks.onmessage === 'function') ? callbacks.onmessage : Janus.noop;
    callbacks.onlocalstream = (typeof callbacks.onlocalstream === 'function') ? callbacks.onlocalstream : Janus.noop;
    callbacks.onremotestream = (typeof callbacks.onremotestream === 'function') ? callbacks.onremotestream : Janus.noop;
    callbacks.ondata = (typeof callbacks.ondata === 'function') ? callbacks.ondata : Janus.noop;
    callbacks.ondataopen = (typeof callbacks.ondataopen === 'function') ? callbacks.ondataopen : Janus.noop;
    callbacks.oncleanup = (typeof callbacks.oncleanup === 'function') ? callbacks.oncleanup : Janus.noop;
    callbacks.ondetached = (typeof callbacks.ondetached === 'function') ? callbacks.ondetached : Janus.noop;
    if (!connected) {
      Janus.warn('Is the server down? (connected=false)');
      callbacks.error('Is the server down? (connected=false)');
      return;
    }
    const plugin = callbacks.plugin;
    if (!plugin) {
      Janus.error('Invalid plugin');
      callbacks.error('Invalid plugin');
      return;
    }
    const opaqueId = callbacks.opaqueId;
    const handleToken = callbacks.token ? callbacks.token : token;
    const transaction = Janus.randomString(12);
    const request = {
      janus: 'attach', plugin, opaque_id: opaqueId, transaction,
    };
    if (handleToken) {
      request.token = handleToken;
    }
    if (apisecret) {
      request.apisecret = apisecret;
    }
    if (websockets) {
      transactions[transaction] = function (json) {
        Janus.debug(json);
        if (json.janus !== 'success') {
          Janus.error(`Ooops: ${json.error.code} ${json.error.reason}`);	// FIXME
          callbacks.error(`Ooops: ${json.error.code} ${json.error.reason}`);
          return;
        }
        const handleId = json.data.id;
        Janus.log(`Created handle: ${handleId}`);
        const pluginHandle =
          {
            session: that,
            plugin,
            id: handleId,
            token: handleToken,
            detached: false,
            webrtcStuff: {
              started: false,
              myStream: null,
              streamExternal: false,
              remoteStream: null,
              mySdp: null,
              mediaConstraints: null,
              pc: null,
              dataChannel: {},
              dtmfSender: null,
              trickle: true,
              iceDone: false,
              volume: {
                value: null,
                timer: null,
              },
              bitrate: {
                value: null,
                bsnow: null,
                bsbefore: null,
                tsnow: null,
                tsbefore: null,
                timer: null,
              },
            },
            getId() {
              return handleId;
            },
            getPlugin() {
              return plugin;
            },
            getVolume() {
              return getVolume(handleId, true);
            },
            getRemoteVolume() {
              return getVolume(handleId, true);
            },
            getLocalVolume() {
              return getVolume(handleId, false);
            },
            isAudioMuted() {
              return isMuted(handleId, false);
            },
            muteAudio() {
              return mute(handleId, false, true);
            },
            unmuteAudio() {
              return mute(handleId, false, false);
            },
            isVideoMuted() {
              return isMuted(handleId, true);
            },
            muteVideo() {
              return mute(handleId, true, true);
            },
            unmuteVideo() {
              return mute(handleId, true, false);
            },
            getBitrate() {
              return getBitrate(handleId);
            },
            send(callbacks) {
              sendMessage(handleId, callbacks);
            },
            data(callbacks) {
              sendData(handleId, callbacks);
            },
            dtmf(callbacks) {
              sendDtmf(handleId, callbacks);
            },
            consentDialog: callbacks.consentDialog,
            iceState: callbacks.iceState,
            mediaState: callbacks.mediaState,
            webrtcState: callbacks.webrtcState,
            slowLink: callbacks.slowLink,
            onmessage: callbacks.onmessage,
            createOffer(callbacks) {
              prepareWebrtc(handleId, true, callbacks);
            },
            createAnswer(callbacks) {
              prepareWebrtc(handleId, false, callbacks);
            },
            handleRemoteJsep(callbacks) {
              prepareWebrtcPeer(handleId, callbacks);
            },
            onlocalstream: callbacks.onlocalstream,
            onremotestream: callbacks.onremotestream,
            ondata: callbacks.ondata,
            ondataopen: callbacks.ondataopen,
            oncleanup: callbacks.oncleanup,
            ondetached: callbacks.ondetached,
            hangup(sendRequest) {
              cleanupWebrtc(handleId, sendRequest === true);
            },
            detach(callbacks) {
              destroyHandle(handleId, callbacks);
            },
          };
        pluginHandles[handleId] = pluginHandle;
        callbacks.success(pluginHandle);
      };
      request.session_id = sessionId;
      ws.send(JSON.stringify(request));
      return;
    }
    Janus.httpAPICall(`${server}/${sessionId}`, {
      verb: 'POST',
      withCredentials,
      body: request,
      success(json) {
        Janus.debug(json);
        if (json.janus !== 'success') {
          Janus.error(`Ooops: ${json.error.code} ${json.error.reason}`);	// FIXME
          callbacks.error(`Ooops: ${json.error.code} ${json.error.reason}`);
          return;
        }
        const handleId = json.data.id;
        Janus.log(`Created handle: ${handleId}`);
        const pluginHandle =
          {
            session: that,
            plugin,
            id: handleId,
            token: handleToken,
            detached: false,
            webrtcStuff: {
              started: false,
              myStream: null,
              streamExternal: false,
              remoteStream: null,
              mySdp: null,
              mediaConstraints: null,
              pc: null,
              dataChannel: {},
              dtmfSender: null,
              trickle: true,
              iceDone: false,
              volume: {
                value: null,
                timer: null,
              },
              bitrate: {
                value: null,
                bsnow: null,
                bsbefore: null,
                tsnow: null,
                tsbefore: null,
                timer: null,
              },
            },
            getId() {
              return handleId;
            },
            getPlugin() {
              return plugin;
            },
            getVolume() {
              return getVolume(handleId, true);
            },
            getRemoteVolume() {
              return getVolume(handleId, true);
            },
            getLocalVolume() {
              return getVolume(handleId, false);
            },
            isAudioMuted() {
              return isMuted(handleId, false);
            },
            muteAudio() {
              return mute(handleId, false, true);
            },
            unmuteAudio() {
              return mute(handleId, false, false);
            },
            isVideoMuted() {
              return isMuted(handleId, true);
            },
            muteVideo() {
              return mute(handleId, true, true);
            },
            unmuteVideo() {
              return mute(handleId, true, false);
            },
            getBitrate() {
              return getBitrate(handleId);
            },
            send(callbacks) {
              sendMessage(handleId, callbacks);
            },
            data(callbacks) {
              sendData(handleId, callbacks);
            },
            dtmf(callbacks) {
              sendDtmf(handleId, callbacks);
            },
            consentDialog: callbacks.consentDialog,
            iceState: callbacks.iceState,
            mediaState: callbacks.mediaState,
            webrtcState: callbacks.webrtcState,
            slowLink: callbacks.slowLink,
            onmessage: callbacks.onmessage,
            createOffer(callbacks) {
              prepareWebrtc(handleId, true, callbacks);
            },
            createAnswer(callbacks) {
              prepareWebrtc(handleId, false, callbacks);
            },
            handleRemoteJsep(callbacks) {
              prepareWebrtcPeer(handleId, callbacks);
            },
            onlocalstream: callbacks.onlocalstream,
            onremotestream: callbacks.onremotestream,
            ondata: callbacks.ondata,
            ondataopen: callbacks.ondataopen,
            oncleanup: callbacks.oncleanup,
            ondetached: callbacks.ondetached,
            hangup(sendRequest) {
              cleanupWebrtc(handleId, sendRequest === true);
            },
            detach(callbacks) {
              destroyHandle(handleId, callbacks);
            },
          };
        pluginHandles[handleId] = pluginHandle;
        callbacks.success(pluginHandle);
      },
      error(textStatus, errorThrown) {
        Janus.error(`${textStatus}:`, errorThrown);	// FIXME
      },
    });
  }

  // Private method to send a message
  function sendMessage(handleId, callbacks) {
    callbacks = callbacks || {};
    callbacks.success = (typeof callbacks.success === 'function') ? callbacks.success : Janus.noop;
    callbacks.error = (typeof callbacks.error === 'function') ? callbacks.error : Janus.noop;
    if (!connected) {
      Janus.warn('Is the server down? (connected=false)');
      callbacks.error('Is the server down? (connected=false)');
      return;
    }
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || !pluginHandle.webrtcStuff) {
      Janus.warn('Invalid handle');
      callbacks.error('Invalid handle');
      return;
    }
    const message = callbacks.message;
    const jsep = callbacks.jsep;
    const transaction = Janus.randomString(12);
    const request = { janus: 'message', body: message, transaction };
    if (pluginHandle.token) {
      request.token = pluginHandle.token;
    }
    if (apisecret) {
      request.apisecret = apisecret;
    }
    if (jsep) {
      request.jsep = jsep;
    }
    Janus.debug(`Sending message to plugin (handle=${handleId}):`);
    Janus.debug(request);
    if (websockets) {
      request.session_id = sessionId;
      request.handle_id = handleId;
      transactions[transaction] = function (json) {
        Janus.debug('Message sent!');
        Janus.debug(json);
        if (json.janus === 'success') {
          // We got a success, must have been a synchronous transaction
          const plugindata = json.plugindata;
          if (!plugindata) {
            Janus.warn('Request succeeded, but missing plugindata...');
            callbacks.success();
            return;
          }
          Janus.log(`Synchronous transaction successful (${plugindata.plugin})`);
          const data = plugindata.data;
          Janus.debug(data);
          callbacks.success(data);
          return;
        } else if (json.janus !== 'ack') {
          // Not a success and not an ack, must be an error
          if (json.error) {
            Janus.error(`Ooops: ${json.error.code} ${json.error.reason}`);	// FIXME
            callbacks.error(`${json.error.code} ${json.error.reason}`);
          } else {
            Janus.error('Unknown error');	// FIXME
            callbacks.error('Unknown error');
          }
          return;
        }
        // If we got here, the plugin decided to handle the request asynchronously
        callbacks.success();
      };
      ws.send(JSON.stringify(request));
      return;
    }
    Janus.httpAPICall(`${server}/${sessionId}/${handleId}`, {
      verb: 'POST',
      withCredentials,
      body: request,
      success(json) {
        Janus.debug('Message sent!');
        Janus.debug(json);
        if (json.janus === 'success') {
          // We got a success, must have been a synchronous transaction
          const plugindata = json.plugindata;
          if (!plugindata) {
            Janus.warn('Request succeeded, but missing plugindata...');
            callbacks.success();
            return;
          }
          Janus.log(`Synchronous transaction successful (${plugindata.plugin})`);
          const data = plugindata.data;
          Janus.debug(data);
          callbacks.success(data);
          return;
        } else if (json.janus !== 'ack') {
          // Not a success and not an ack, must be an error
          if (json.error) {
            Janus.error(`Ooops: ${json.error.code} ${json.error.reason}`);	// FIXME
            callbacks.error(`${json.error.code} ${json.error.reason}`);
          } else {
            Janus.error('Unknown error');	// FIXME
            callbacks.error('Unknown error');
          }
          return;
        }
        // If we got here, the plugin decided to handle the request asynchronously
        callbacks.success();
      },
      error(textStatus, errorThrown) {
        Janus.error(`${textStatus}:`, errorThrown);	// FIXME
        callbacks.error(`${textStatus}: ${errorThrown}`);
      },
    });
  }

  // Private method to send a trickle candidate
  function sendTrickleCandidate(handleId, candidate) {
    if (!connected) {
      Janus.warn('Is the server down? (connected=false)');
      return;
    }
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || !pluginHandle.webrtcStuff) {
      Janus.warn('Invalid handle');
      return;
    }
    const request = { janus: 'trickle', candidate, transaction: Janus.randomString(12) };
    if (pluginHandle.token) {
      request.token = pluginHandle.token;
    }
    if (apisecret) {
      request.apisecret = apisecret;
    }
    Janus.vdebug(`Sending trickle candidate (handle=${handleId}):`);
    Janus.vdebug(request);
    if (websockets) {
      request.session_id = sessionId;
      request.handle_id = handleId;
      ws.send(JSON.stringify(request));
      return;
    }
    Janus.httpAPICall(`${server}/${sessionId}/${handleId}`, {
      verb: 'POST',
      withCredentials,
      body: request,
      success(json) {
        Janus.vdebug('Candidate sent!');
        Janus.vdebug(json);
        if (json.janus !== 'ack') {
          Janus.error(`Ooops: ${json.error.code} ${json.error.reason}`);	// FIXME
        }
      },
      error(textStatus, errorThrown) {
        Janus.error(`${textStatus}:`, errorThrown);	// FIXME
      },
    });
  }

  // Private method to create a data channel
  function createDataChannel(handleId, dclabel, incoming, pendingText) {
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || !pluginHandle.webrtcStuff) {
      Janus.warn('Invalid handle');
      return;
    }
    const config = pluginHandle.webrtcStuff;
    console.log('Create data channel `webrtcStuff`', config);
    const onDataChannelMessage = function (event) {
      Janus.log('Received message on data channel:', event);
      const label = event.target.label;
      pluginHandle.ondata(event.data, label);
    };
    const onDataChannelStateChange = function (event) {
      Janus.log('Received state change on data channel:', event);
      if (! event.target || !event.target.label) {
        return;
      }
      const label = event.target.label;
      const dcState = config.dataChannel[label] ? config.dataChannel[label].readyState : 'null';
      Janus.log(`State change on <${label}> data channel: ${dcState}`);
      if (dcState === 'open') {
        // Any pending messages to send?
        if (config.dataChannel[label].pending && config.dataChannel[label].pending.length > 0) {
          Janus.log(`Sending pending messages on <${label}>:`, config.dataChannel[label].pending.length);
          for (const text of config.dataChannel[label].pending) {
            Janus.log(`Sending string on data channel <${label}>: ${text}`);
            config.dataChannel[label].send(text);
          }
          config.dataChannel[label].pending = [];
        }
        // Notify the open data channel
        pluginHandle.ondataopen(label);
      }
    };
    const onDataChannelError = function (error) {
      Janus.error('Got error on data channel:', error);
      // TODO
    };
    if (!incoming) {
      // FIXME Add options (ordered, maxRetransmits, etc.)
      config.dataChannel[dclabel] = config.pc.createDataChannel(dclabel, { ordered: false });
    } else {
      // The channel was created by Janus
      config.dataChannel[dclabel] = incoming;
    }
    config.dataChannel[dclabel].onmessage = onDataChannelMessage;
    config.dataChannel[dclabel].onopen = onDataChannelStateChange;
    config.dataChannel[dclabel].onclose = onDataChannelStateChange;
    config.dataChannel[dclabel].onerror = onDataChannelError;
    config.dataChannel[dclabel].pending = [];
    if (pendingText) {
      config.dataChannel[dclabel].pending.push(pendingText);
    }
  }

  // Private method to send a data channel message
  function sendData(handleId, callbacks) {
    callbacks = callbacks || {};
    callbacks.success = (typeof callbacks.success === 'function') ? callbacks.success : Janus.noop;
    callbacks.error = (typeof callbacks.error === 'function') ? callbacks.error : Janus.noop;
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || !pluginHandle.webrtcStuff) {
      Janus.warn('Invalid handle');
      callbacks.error('Invalid handle');
      return;
    }
    const config = pluginHandle.webrtcStuff;
    const text = callbacks.text;
    if (!text) {
      Janus.warn('Invalid text');
      callbacks.error('Invalid text');
      return;
    }
    const label = callbacks.label ? callbacks.label : Janus.dataChanDefaultLabel;
    if (!config.dataChannel[label]) {
      // Create new data channel and wait for it to open
      createDataChannel(handleId, label, false, text);
      callbacks.success();
      return;
    }
    if (config.dataChannel[label].readyState !== 'open') {
      config.dataChannel[label].pending.push(text);
      callbacks.success();
      return;
    }
    Janus.log(`Sending string on data channel <${label}>: ${text}`);
    config.dataChannel[label].send(text);
    callbacks.success();
  }

  // Private method to send a DTMF tone
  function sendDtmf(handleId, callbacks) {
    callbacks = callbacks || {};
    callbacks.success = (typeof callbacks.success === 'function') ? callbacks.success : Janus.noop;
    callbacks.error = (typeof callbacks.error === 'function') ? callbacks.error : Janus.noop;
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || !pluginHandle.webrtcStuff) {
      Janus.warn('Invalid handle');
      callbacks.error('Invalid handle');
      return;
    }
    const config = pluginHandle.webrtcStuff;
    if (!config.dtmfSender) {
      // Create the DTMF sender the proper way, if possible
      if (config.pc) {
        const senders = config.pc.getSenders();
        const audioSender = senders.find(sender => sender.track && sender.track.kind === 'audio');
        if (!audioSender) {
          Janus.warn('Invalid DTMF configuration (no audio track)');
          callbacks.error('Invalid DTMF configuration (no audio track)');
          return;
        }
        config.dtmfSender = audioSender.dtmf;
        if (config.dtmfSender) {
          Janus.log('Created DTMF Sender');
          config.dtmfSender.ontonechange = function (tone) {
            Janus.debug(`Sent DTMF tone: ${tone.tone}`);
          };
        }
      }
      if (!config.dtmfSender) {
        Janus.warn('Invalid DTMF configuration');
        callbacks.error('Invalid DTMF configuration');
        return;
      }
    }
    const dtmf = callbacks.dtmf;
    if (!dtmf) {
      Janus.warn('Invalid DTMF parameters');
      callbacks.error('Invalid DTMF parameters');
      return;
    }
    const tones = dtmf.tones;
    if (!tones) {
      Janus.warn('Invalid DTMF string');
      callbacks.error('Invalid DTMF string');
      return;
    }
    const duration = (typeof dtmf.duration === 'number') ? dtmf.duration : 500; // We choose 500ms as the default duration for a tone
    const gap = (typeof dtmf.gap === 'number') ? dtmf.gap : 50; // We choose 50ms as the default gap between tones
    Janus.debug(`Sending DTMF string ${tones} (duration ${duration}ms, gap ${gap}ms)`);
    config.dtmfSender.insertDTMF(tones, duration, gap);
    callbacks.success();
  }

  // Private method to destroy a plugin handle
  function destroyHandle(handleId, callbacks) {
    callbacks = callbacks || {};
    callbacks.success = (typeof callbacks.success === 'function') ? callbacks.success : Janus.noop;
    callbacks.error = (typeof callbacks.error === 'function') ? callbacks.error : Janus.noop;
    let asyncRequest = true;
    if (callbacks.asyncRequest !== undefined && callbacks.asyncRequest !== null) {
      asyncRequest = (callbacks.asyncRequest === true);
    }
    let noRequest = true;
    if (callbacks.noRequest !== undefined && callbacks.noRequest !== null) {
      noRequest = (callbacks.noRequest === true);
    }
    Janus.log(`Destroying handle ${handleId} (async=${asyncRequest})`);
    cleanupWebrtc(handleId);
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || pluginHandle.detached) {
      // Plugin was already detached by Janus, calling detach again will return a handle not found error, so just exit here
      delete pluginHandles[handleId];
      callbacks.success();
      return;
    }
    if (noRequest) {
      // We're only removing the handle locally
      delete pluginHandles[handleId];
      callbacks.success();
      return;
    }
    if (!connected) {
      Janus.warn('Is the server down? (connected=false)');
      callbacks.error('Is the server down? (connected=false)');
      return;
    }
    const request = { janus: 'detach', transaction: Janus.randomString(12) };
    if (pluginHandle.token) {
      request.token = pluginHandle.token;
    }
    if (apisecret) {
      request.apisecret = apisecret;
    }
    if (websockets) {
      request.session_id = sessionId;
      request.handle_id = handleId;
      ws.send(JSON.stringify(request));
      delete pluginHandles[handleId];
      callbacks.success();
      return;
    }
    Janus.httpAPICall(`${server}/${sessionId}/${handleId}`, {
      verb: 'POST',
      async: asyncRequest,	// Sometimes we need false here, or destroying in onbeforeunload won't work
      withCredentials,
      body: request,
      success(json) {
        Janus.log('Destroyed handle:');
        Janus.debug(json);
        if (json.janus !== 'success') {
          Janus.error(`Ooops: ${json.error.code} ${json.error.reason}`);	// FIXME
        }
        delete pluginHandles[handleId];
        callbacks.success();
      },
      error(textStatus, errorThrown) {
        Janus.error(`${textStatus}:`, errorThrown);	// FIXME
        // We cleanup anyway
        delete pluginHandles[handleId];
        callbacks.success();
      },
    });
  }

  // WebRTC stuff
  function streamsDone(handleId, jsep, media, callbacks, stream) {
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || !pluginHandle.webrtcStuff) {
      Janus.warn('Invalid handle');
      callbacks.error('Invalid handle');
      return;
    }
    const config = pluginHandle.webrtcStuff;
    Janus.debug('streamsDone:', stream);
    if (stream) {
      Janus.debug('  -- Audio tracks:', stream.getAudioTracks());
      Janus.debug('  -- Video tracks:', stream.getVideoTracks());
    }
    // We're now capturing the new stream: check if we're updating or if it's a new thing
    let addTracks = false;
    if (!config.myStream || !media.update || config.streamExternal) {
      config.myStream = stream;
      addTracks = true;
    } else {
      // We only need to update the existing stream
      if (((!media.update && isAudioSendEnabled(media)) || (media.update && (media.addAudio || media.replaceAudio))) &&
        stream.getAudioTracks() && stream.getAudioTracks().length) {
        config.myStream.addTrack(stream.getAudioTracks()[0]);
        if (Janus.unifiedPlan) {
          // Use Transceivers
          Janus.log(`${media.replaceAudio ? 'Replacing' : 'Adding'} audio track:`, stream.getAudioTracks()[0]);
          let audioTransceiver = null;
          var transceivers = config.pc.getTransceivers();
          if (transceivers && transceivers.length > 0) {
            for (var t of transceivers) {
              if ((t.sender && t.sender.track && t.sender.track.kind === 'audio') ||
                (t.receiver && t.receiver.track && t.receiver.track.kind === 'audio')) {
                audioTransceiver = t;
                break;
              }
            }
          }
          if (audioTransceiver && audioTransceiver.sender) {
            audioTransceiver.sender.replaceTrack(stream.getAudioTracks()[0]);
          } else {
            config.pc.addTrack(stream.getAudioTracks()[0], stream);
          }
        } else {
          Janus.log(`${media.replaceAudio ? 'Replacing' : 'Adding'} audio track:`, stream.getAudioTracks()[0]);
          config.pc.addTrack(stream.getAudioTracks()[0], stream);
        }
      }
      if (((!media.update && isVideoSendEnabled(media)) || (media.update && (media.addVideo || media.replaceVideo))) &&
        stream.getVideoTracks() && stream.getVideoTracks().length) {
        config.myStream.addTrack(stream.getVideoTracks()[0]);
        if (Janus.unifiedPlan) {
          // Use Transceivers
          Janus.log(`${media.replaceVideo ? 'Replacing' : 'Adding'} video track:`, stream.getVideoTracks()[0]);
          let videoTransceiver = null;
          var transceivers = config.pc.getTransceivers();
          if (transceivers && transceivers.length > 0) {
            for (var t of transceivers) {
              if ((t.sender && t.sender.track && t.sender.track.kind === 'video') ||
                (t.receiver && t.receiver.track && t.receiver.track.kind === 'video')) {
                videoTransceiver = t;
                break;
              }
            }
          }
          if (videoTransceiver && videoTransceiver.sender) {
            videoTransceiver.sender.replaceTrack(stream.getVideoTracks()[0]);
          } else {
            config.pc.addTrack(stream.getVideoTracks()[0], stream);
          }
        } else {
          Janus.log(`${media.replaceVideo ? 'Replacing' : 'Adding'} video track:`, stream.getVideoTracks()[0]);
          config.pc.addTrack(stream.getVideoTracks()[0], stream);
        }
      }
    }
    // If we still need to create a PeerConnection, let's do that
    if (!config.pc) {
      const pc_config = {
        iceServers,
        iceTransportPolicy,
        bundlePolicy,
      };
      pc_config.sdpSemantics = 'plan-b';

      const pc_constraints = {
        optional: [{ DtlsSrtpKeyAgreement: true }],
      };
      if (ipv6Support) {
        pc_constraints.optional.push({ googIPv6: true });
      }
      // Any custom constraint to add?
      if (callbacks.rtcConstraints && typeof callbacks.rtcConstraints === 'object') {
        Janus.debug('Adding custom PeerConnection constraints:', callbacks.rtcConstraints);
        for (const i in callbacks.rtcConstraints) {
          pc_constraints.optional.push(callbacks.rtcConstraints[i]);
        }
      }
      Janus.log('Creating PeerConnection');
      Janus.debug(pc_constraints);
      config.pc = new wrtc.RTCPeerConnection(pc_config, pc_constraints);
      Janus.debug(config.pc);
      if (config.pc.getStats) {	// FIXME
        config.volume = {};
        config.bitrate.value = '0 kbits/sec';
      }
      Janus.log(`Preparing local SDP and gathering candidates (trickle=${config.trickle})`);
      config.pc.oniceconnectionstatechange = function (e) {
        if (config.pc) {
          pluginHandle.iceState(config.pc.iceConnectionState);
        }
      };
      config.pc.onicecandidate = function (event) {
        if (config.trickle === true) {
          // Send candidate
          sendTrickleCandidate(handleId, event);
        }
      };
      config.pc.ontrack = function (event) {
        Janus.log('Handling Remote Track');
        Janus.debug(event);
        if (!event.streams) {
          return;
        }
        config.remoteStream = event.streams[0];
        pluginHandle.onremotestream(config.remoteStream);
        if (event.track.onended) {
          return;
        }
        Janus.log('Adding onended callback to track:', event.track);
        event.track.onended = function (ev) {
          Janus.log('Remote track muted/removed:', ev);
          if (config.remoteStream) {
            config.remoteStream.removeTrack(ev.target);
            pluginHandle.onremotestream(config.remoteStream);
          }
        };
        event.track.onmute = event.track.onended;
        event.track.onunmute = function (ev) {
          Janus.log('Remote track flowing again:', ev);
          try {
            config.remoteStream.addTrack(ev.target);
            pluginHandle.onremotestream(config.remoteStream);
          } catch (e) {
            Janus.error(e);
          }
        };
      };
    }
    if (addTracks && stream) {
      Janus.log('Adding local stream');
      const simulcast2 = (callbacks.simulcast2 === true);
      stream.getTracks().forEach((track) => {
        Janus.log('Adding local track:', track);
        if (!simulcast2) {
          config.pc.addTrack(track, stream);
        } else if (track.kind === 'audio') {
          config.pc.addTrack(track, stream);
        } else {
          Janus.log('Enabling rid-based simulcasting:', track);
          const maxBitrates = getMaxBitrates(callbacks.simulcastMaxBitrates);
          config.pc.addTransceiver(track, {
            direction: 'sendrecv',
            streams: [stream],
            sendEncodings: [
              { rid: 'h', active: true, maxBitrate: maxBitrates.high },
              {
                rid: 'm', active: true, maxBitrate: maxBitrates.medium, scaleResolutionDownBy: 2,
              },
              {
                rid: 'l', active: true, maxBitrate: maxBitrates.low, scaleResolutionDownBy: 4,
              },
            ],
          });
        }
      });
    }
    // Any data channel to create?
    if (isDataEnabled(media) && !config.dataChannel[Janus.dataChanDefaultLabel]) {
      Janus.log('Creating data channel');
      createDataChannel(handleId, Janus.dataChanDefaultLabel, false);
      config.pc.ondatachannel = function (event) {
        Janus.log('Data channel created by Janus:', event);
        createDataChannel(handleId, event.channel.label, event.channel);
      };
    }
    // If there's a new local stream, let's notify the application
    if (config.myStream) {
      pluginHandle.onlocalstream(config.myStream);
    }
    // Create offer/answer now
    if (!jsep) {
      createOffer(handleId, media, callbacks);
    } else {
      config.pc.setRemoteDescription(jsep)
        .then(() => {
          Janus.log('Remote description accepted!');
          config.remoteSdp = jsep.sdp;
          // Any trickle candidate we cached?
          if (config.candidates && config.candidates.length > 0) {
            for (let i = 0; i < config.candidates.length; i++) {
              const candidate = config.candidates[i];
              Janus.debug('Adding remote candidate:', candidate);
              if (!candidate || candidate.completed === true) {
                // end-of-candidates
                config.pc.addIceCandidate(Janus.endOfCandidates);
              } else {
                // New candidate
                config.pc.addIceCandidate(candidate);
              }
            }
            config.candidates = [];
          }
          // Create the answer now
          createAnswer(handleId, media, callbacks);
        }, callbacks.error);
    }
  }

  function prepareWebrtc(handleId, offer, callbacks) {
    callbacks = callbacks || {};
    callbacks.success = (typeof callbacks.success === 'function') ? callbacks.success : Janus.noop;
    callbacks.error = (typeof callbacks.error === 'function') ? callbacks.error : webrtcError;
    const jsep = callbacks.jsep;
    if (offer && jsep) {
      Janus.error('Provided a JSEP to a createOffer');
      callbacks.error('Provided a JSEP to a createOffer');
      return;
    } else if (!offer && (!jsep || !jsep.type || !jsep.sdp)) {
      Janus.error('A valid JSEP is required for createAnswer');
      callbacks.error('A valid JSEP is required for createAnswer');
      return;
    }
    /* Check that callbacks.media is a (not null) Object */
    callbacks.media = (typeof callbacks.media === 'object' && callbacks.media) ? callbacks.media : {
      audio: true,
      video: true,
    };
    const media = callbacks.media;
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || !pluginHandle.webrtcStuff) {
      Janus.warn('Invalid handle');
      callbacks.error('Invalid handle');
      return;
    }
    const config = pluginHandle.webrtcStuff;
    config.trickle = isTrickleEnabled(callbacks.trickle);
    // Are we updating a session?
    if (!config.pc) {
      // Nope, new PeerConnection
      media.update = false;
      media.keepAudio = false;
      media.keepVideo = false;
    } else {
      Janus.log('Updating existing media session');
      media.update = true;
      // Check if there's anything to add/remove/replace, or if we
      // can go directly to preparing the new SDP offer or answer
      if (callbacks.stream) {
        // External stream: is this the same as the one we were using before?
        if (callbacks.stream !== config.myStream) {
          Janus.log('Renegotiation involves a new external stream');
        }
      } else {
        // Check if there are changes on audio
        if (media.addAudio) {
          media.keepAudio = false;
          media.replaceAudio = false;
          media.removeAudio = false;
          media.audioSend = true;
          if (config.myStream && config.myStream.getAudioTracks() && config.myStream.getAudioTracks().length) {
            Janus.error("Can't add audio stream, there already is one");
            callbacks.error("Can't add audio stream, there already is one");
            return;
          }
        } else if (media.removeAudio) {
          media.keepAudio = false;
          media.replaceAudio = false;
          media.addAudio = false;
          media.audioSend = false;
        } else if (media.replaceAudio) {
          media.keepAudio = false;
          media.addAudio = false;
          media.removeAudio = false;
          media.audioSend = true;
        }
        if (!config.myStream) {
          // No media stream: if we were asked to replace, it's actually an "add"
          if (media.replaceAudio) {
            media.keepAudio = false;
            media.replaceAudio = false;
            media.addAudio = true;
            media.audioSend = true;
          }
          if (isAudioSendEnabled(media)) {
            media.keepAudio = false;
            media.addAudio = true;
          }
        } else if (!config.myStream.getAudioTracks() || config.myStream.getAudioTracks().length === 0) {
          // No audio track: if we were asked to replace, it's actually an "add"
          if (media.replaceAudio) {
            media.keepAudio = false;
            media.replaceAudio = false;
            media.addAudio = true;
            media.audioSend = true;
          }
          if (isAudioSendEnabled(media)) {
            media.keepVideo = false;
            media.addAudio = true;
          }
        } else {
          // We have an audio track: should we keep it as it is?
          if (isAudioSendEnabled(media) &&
            !media.removeAudio && !media.replaceAudio) {
            media.keepAudio = true;
          }
        }
        // Check if there are changes on video
        if (media.addVideo) {
          media.keepVideo = false;
          media.replaceVideo = false;
          media.removeVideo = false;
          media.videoSend = true;
          if (config.myStream && config.myStream.getVideoTracks() && config.myStream.getVideoTracks().length) {
            Janus.error("Can't add video stream, there already is one");
            callbacks.error("Can't add video stream, there already is one");
            return;
          }
        } else if (media.removeVideo) {
          media.keepVideo = false;
          media.replaceVideo = false;
          media.addVideo = false;
          media.videoSend = false;
        } else if (media.replaceVideo) {
          media.keepVideo = false;
          media.addVideo = false;
          media.removeVideo = false;
          media.videoSend = true;
        }
        if (!config.myStream) {
          // No media stream: if we were asked to replace, it's actually an "add"
          if (media.replaceVideo) {
            media.keepVideo = false;
            media.replaceVideo = false;
            media.addVideo = true;
            media.videoSend = true;
          }
          if (isVideoSendEnabled(media)) {
            media.keepVideo = false;
            media.addVideo = true;
          }
        } else if (!config.myStream.getVideoTracks() || config.myStream.getVideoTracks().length === 0) {
          // No video track: if we were asked to replace, it's actually an "add"
          if (media.replaceVideo) {
            media.keepVideo = false;
            media.replaceVideo = false;
            media.addVideo = true;
            media.videoSend = true;
          }
          if (isVideoSendEnabled(media)) {
            media.keepVideo = false;
            media.addVideo = true;
          }
        } else {
          // We have a video track: should we keep it as it is?
          if (isVideoSendEnabled(media) &&
            !media.removeVideo && !media.replaceVideo) {
            media.keepVideo = true;
          }
        }
        // Data channels can only be added
        if (media.addData) {
          media.data = true;
        }
      }
      // If we're updating and keeping all tracks, let's skip the getUserMedia part
      if ((isAudioSendEnabled(media) && media.keepAudio) &&
        (isVideoSendEnabled(media) && media.keepVideo)) {
        pluginHandle.consentDialog(false);
        streamsDone(handleId, jsep, media, callbacks, config.myStream);
        return;
      }
    }
    // If we're updating, check if we need to remove/replace one of the tracks
    if (media.update && !config.streamExternal) {
      if (media.removeAudio || media.replaceAudio) {
        if (config.myStream && config.myStream.getAudioTracks() && config.myStream.getAudioTracks().length) {
          var s = config.myStream.getAudioTracks()[0];
          Janus.log('Removing audio track:', s);
          config.myStream.removeTrack(s);
          try {
            s.stop();
          } catch (e) {
          }
        }
        if (config.pc.getSenders() && config.pc.getSenders().length) {
          let ra = true;
          if (media.replaceAudio && Janus.unifiedPlan) {
            // We can use replaceTrack
            ra = false;
          }
          if (ra) {
            for (var s of config.pc.getSenders()) {
              if (s && s.track && s.track.kind === 'audio') {
                Janus.log('Removing audio sender:', s);
                config.pc.removeTrack(s);
              }
            }
          }
        }
      }
      if (media.removeVideo || media.replaceVideo) {
        if (config.myStream && config.myStream.getVideoTracks() && config.myStream.getVideoTracks().length) {
          var s = config.myStream.getVideoTracks()[0];
          Janus.log('Removing video track:', s);
          config.myStream.removeTrack(s);
          try {
            s.stop();
          } catch (e) {
          }
        }
        if (config.pc.getSenders() && config.pc.getSenders().length) {
          let rv = true;
          if (media.replaceVideo && Janus.unifiedPlan) {
            // We can use replaceTrack
            rv = false;
          }
          if (rv) {
            for (var s of config.pc.getSenders()) {
              if (s && s.track && s.track.kind === 'video') {
                Janus.log('Removing video sender:', s);
                config.pc.removeTrack(s);
              }
            }
          }
        }
      }
    }
    // Was a MediaStream object passed, or do we need to take care of that?
    if (callbacks.stream) {
      var stream = callbacks.stream;
      Janus.log('MediaStream provided by the application');
      Janus.debug(stream);
      // If this is an update, let's check if we need to release the previous stream
      if (media.update) {
        if (config.myStream && config.myStream !== callbacks.stream && !config.streamExternal) {
          // We're replacing a stream we captured ourselves with an external one
          try {
            // Try a MediaStreamTrack.stop() for each track
            const tracks = config.myStream.getTracks();
            for (const mst of tracks) {
              Janus.log(mst);
              if (mst) {
                mst.stop();
              }
            }
          } catch (e) {
            // Do nothing if this fails
          }
          config.myStream = null;
        }
      }
      // Skip the getUserMedia part
      config.streamExternal = true;
      pluginHandle.consentDialog(false);
      streamsDone(handleId, jsep, media, callbacks, stream);
      return;
    }
      // No need to do a getUserMedia, create offer/answer right away
      streamsDone(handleId, jsep, media, callbacks);
  }

  function prepareWebrtcPeer(handleId, callbacks) {
    callbacks = callbacks || {};
    callbacks.success = (typeof callbacks.success === 'function') ? callbacks.success : Janus.noop;
    callbacks.error = (typeof callbacks.error === 'function') ? callbacks.error : webrtcError;
    const jsep = callbacks.jsep;
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || !pluginHandle.webrtcStuff) {
      Janus.warn('Invalid handle');
      callbacks.error('Invalid handle');
      return;
    }
    const config = pluginHandle.webrtcStuff;
    if (jsep) {
      if (!config.pc) {
        Janus.warn('Wait, no PeerConnection?? if this is an answer, use createAnswer and not handleRemoteJsep');
        callbacks.error('No PeerConnection: if this is an answer, use createAnswer and not handleRemoteJsep');
        return;
      }
      config.pc.setRemoteDescription(jsep)
        .then(() => {
          Janus.log('Remote description accepted!');
          config.remoteSdp = jsep.sdp;
          // Any trickle candidate we cached?
          if (config.candidates && config.candidates.length > 0) {
            for (let i = 0; i < config.candidates.length; i++) {
              const candidate = config.candidates[i];
              Janus.debug('Adding remote candidate:', candidate);
              if (!candidate || candidate.completed === true) {
                // end-of-candidates
                config.pc.addIceCandidate(Janus.endOfCandidates);
              } else {
                // New candidate
                config.pc.addIceCandidate(candidate);
              }
            }
            config.candidates = [];
          }
          // Done
          callbacks.success();
        }, callbacks.error);
    } else {
      callbacks.error('Invalid JSEP');
    }
  }

  function createOffer(handleId, media, callbacks) {
    callbacks = callbacks || {};
    callbacks.success = (typeof callbacks.success === 'function') ? callbacks.success : Janus.noop;
    callbacks.error = (typeof callbacks.error === 'function') ? callbacks.error : Janus.noop;
    callbacks.customizeSdp = (typeof callbacks.customizeSdp === 'function') ? callbacks.customizeSdp : Janus.noop;
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || !pluginHandle.webrtcStuff) {
      Janus.warn('Invalid handle');
      callbacks.error('Invalid handle');
      return;
    }
    const config = pluginHandle.webrtcStuff;
    const simulcast = (callbacks.simulcast === true);
    if (!simulcast) {
      Janus.log(`Creating offer (iceDone=${config.iceDone})`);
    } else {
      Janus.log(`Creating offer (iceDone=${config.iceDone}, simulcast=${simulcast})`);
    }
    // https://code.google.com/p/webrtc/issues/detail?id=3508
    const mediaConstraints = {};
    if (Janus.unifiedPlan) {
      // We can use Transceivers
      let audioTransceiver = null,
        videoTransceiver = null;
      const transceivers = config.pc.getTransceivers();
      if (transceivers && transceivers.length > 0) {
        for (const t of transceivers) {
          if ((t.sender && t.sender.track && t.sender.track.kind === 'audio') ||
            (t.receiver && t.receiver.track && t.receiver.track.kind === 'audio')) {
            if (!audioTransceiver) {
              audioTransceiver = t;
            }
            continue;
          }
          if ((t.sender && t.sender.track && t.sender.track.kind === 'video') ||
            (t.receiver && t.receiver.track && t.receiver.track.kind === 'video')) {
            if (!videoTransceiver) {
              videoTransceiver = t;
            }
            continue;
          }
        }
      }
      // Handle audio (and related changes, if any)
      const audioSend = isAudioSendEnabled(media);
      const audioRecv = isAudioRecvEnabled(media);
      if (!audioSend && !audioRecv) {
        // Audio disabled: have we removed it?
        if (media.removeAudio && audioTransceiver) {
          if (audioTransceiver.setDirection) {
            audioTransceiver.setDirection('inactive');
          } else {
            audioTransceiver.direction = 'inactive';
          }
          Janus.log('Setting audio transceiver to inactive:', audioTransceiver);
        }
      } else {
        // Take care of audio m-line
        if (audioSend && audioRecv) {
          if (audioTransceiver) {
            if (audioTransceiver.setDirection) {
              audioTransceiver.setDirection('sendrecv');
            } else {
              audioTransceiver.direction = 'sendrecv';
            }
            Janus.log('Setting audio transceiver to sendrecv:', audioTransceiver);
          }
        } else if (audioSend && !audioRecv) {
          if (audioTransceiver) {
            if (audioTransceiver.setDirection) {
              audioTransceiver.setDirection('sendonly');
            } else {
              audioTransceiver.direction = 'sendonly';
            }
            Janus.log('Setting audio transceiver to sendonly:', audioTransceiver);
          }
        } else if (!audioSend && audioRecv) {
          if (audioTransceiver) {
            if (audioTransceiver.setDirection) {
              audioTransceiver.setDirection('recvonly');
            } else {
              audioTransceiver.direction = 'recvonly';
            }
            Janus.log('Setting audio transceiver to recvonly:', audioTransceiver);
          } else {
            // In theory, this is the only case where we might not have a transceiver yet
            audioTransceiver = config.pc.addTransceiver('audio', { direction: 'recvonly' });
            Janus.log('Adding recvonly audio transceiver:', audioTransceiver);
          }
        }
      }
      // Handle video (and related changes, if any)
      const videoSend = isVideoSendEnabled(media);
      const videoRecv = isVideoRecvEnabled(media);
      if (!videoSend && !videoRecv) {
        // Video disabled: have we removed it?
        if (media.removeVideo && videoTransceiver) {
          if (videoTransceiver.setDirection) {
            videoTransceiver.setDirection('inactive');
          } else {
            videoTransceiver.direction = 'inactive';
          }
          Janus.log('Setting video transceiver to inactive:', videoTransceiver);
        }
      } else {
        // Take care of video m-line
        if (videoSend && videoRecv) {
          if (videoTransceiver) {
            if (videoTransceiver.setDirection) {
              videoTransceiver.setDirection('sendrecv');
            } else {
              videoTransceiver.direction = 'sendrecv';
            }
            Janus.log('Setting video transceiver to sendrecv:', videoTransceiver);
          }
        } else if (videoSend && !videoRecv) {
          if (videoTransceiver) {
            if (videoTransceiver.setDirection) {
              videoTransceiver.setDirection('sendonly');
            } else {
              videoTransceiver.direction = 'sendonly';
            }
            Janus.log('Setting video transceiver to sendonly:', videoTransceiver);
          }
        } else if (!videoSend && videoRecv) {
          if (videoTransceiver) {
            if (videoTransceiver.setDirection) {
              videoTransceiver.setDirection('recvonly');
            } else {
              videoTransceiver.direction = 'recvonly';
            }
            Janus.log('Setting video transceiver to recvonly:', videoTransceiver);
          } else {
            // In theory, this is the only case where we might not have a transceiver yet
            videoTransceiver = config.pc.addTransceiver('video', { direction: 'recvonly' });
            Janus.log('Adding recvonly video transceiver:', videoTransceiver);
          }
        }
      }
    } else {
      mediaConstraints.offerToReceiveAudio = isAudioRecvEnabled(media);
      mediaConstraints.offerToReceiveVideo = isVideoRecvEnabled(media);
    }
    const iceRestart = (callbacks.iceRestart === true);
    if (iceRestart) {
      mediaConstraints.iceRestart = true;
    }
    Janus.debug(mediaConstraints);
    // Check if this is Firefox and we've been asked to do simulcasting
    config.pc.createOffer(callbacks.success, callbacks.error)
      .then((offer) => {
        Janus.debug(offer);
        // JSON.stringify doesn't work on some WebRTC objects anymore
        // See https://code.google.com/p/chromium/issues/detail?id=467366
        const jsep = {
          type: offer.type,
          sdp: offer.sdp,
        };
        callbacks.customizeSdp(jsep);
        offer.sdp = jsep.sdp;
        Janus.log('Setting local description');
        config.mySdp = offer.sdp;
        config.pc.setLocalDescription(offer)
          .catch(callbacks.error);
        config.mediaConstraints = mediaConstraints;
        if (!config.iceDone && !config.trickle) {
          // Don't do anything until we have all candidates
          Janus.log('Waiting for all candidates...');
          return;
        }
        Janus.log('Offer ready');
        Janus.debug(callbacks);
        callbacks.success(offer);
      }, callbacks.error);
  }

  function createAnswer(handleId, media, callbacks) {
    callbacks = callbacks || {};
    callbacks.success = (typeof callbacks.success === 'function') ? callbacks.success : Janus.noop;
    callbacks.error = (typeof callbacks.error === 'function') ? callbacks.error : Janus.noop;
    callbacks.customizeSdp = (typeof callbacks.customizeSdp === 'function') ? callbacks.customizeSdp : Janus.noop;
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || !pluginHandle.webrtcStuff) {
      Janus.warn('Invalid handle');
      callbacks.error('Invalid handle');
      return;
    }
    const config = pluginHandle.webrtcStuff;
    const simulcast = (callbacks.simulcast === true);
    if (!simulcast) {
      Janus.log(`Creating answer (iceDone=${config.iceDone})`);
    } else {
      Janus.log(`Creating answer (iceDone=${config.iceDone}, simulcast=${simulcast})`);
    }
    let mediaConstraints = null;
    if (Janus.unifiedPlan) {
      // We can use Transceivers
      mediaConstraints = {};
      let audioTransceiver = null,
        videoTransceiver = null;
      const transceivers = config.pc.getTransceivers();
      if (transceivers && transceivers.length > 0) {
        for (const t of transceivers) {
          if ((t.sender && t.sender.track && t.sender.track.kind === 'audio') ||
            (t.receiver && t.receiver.track && t.receiver.track.kind === 'audio')) {
            if (!audioTransceiver) {
              audioTransceiver = t;
            }
            continue;
          }
          if ((t.sender && t.sender.track && t.sender.track.kind === 'video') ||
            (t.receiver && t.receiver.track && t.receiver.track.kind === 'video')) {
            if (!videoTransceiver) {
              videoTransceiver = t;
            }
            continue;
          }
        }
      }
      // Handle audio (and related changes, if any)
      const audioSend = isAudioSendEnabled(media);
      const audioRecv = isAudioRecvEnabled(media);
      if (!audioSend && !audioRecv) {
        // Audio disabled: have we removed it?
        if (media.removeAudio && audioTransceiver) {
          try {
            if (audioTransceiver.setDirection) {
              audioTransceiver.setDirection('inactive');
            } else {
              audioTransceiver.direction = 'inactive';
            }
            Janus.log('Setting audio transceiver to inactive:', audioTransceiver);
          } catch (e) {
            Janus.error(e);
          }
        }
      } else {
        // Take care of audio m-line
        if (audioSend && audioRecv) {
          if (audioTransceiver) {
            try {
              if (audioTransceiver.setDirection) {
                audioTransceiver.setDirection('sendrecv');
              } else {
                audioTransceiver.direction = 'sendrecv';
              }
              Janus.log('Setting audio transceiver to sendrecv:', audioTransceiver);
            } catch (e) {
              Janus.error(e);
            }
          }
        } else if (audioSend && !audioRecv) {
          try {
            if (audioTransceiver) {
              if (audioTransceiver.setDirection) {
                audioTransceiver.setDirection('sendonly');
              } else {
                audioTransceiver.direction = 'sendonly';
              }
              Janus.log('Setting audio transceiver to sendonly:', audioTransceiver);
            }
          } catch (e) {
            Janus.error(e);
          }
        } else if (!audioSend && audioRecv) {
          if (audioTransceiver) {
            try {
              if (audioTransceiver.setDirection) {
                audioTransceiver.setDirection('recvonly');
              } else {
                audioTransceiver.direction = 'recvonly';
              }
              Janus.log('Setting audio transceiver to recvonly:', audioTransceiver);
            } catch (e) {
              Janus.error(e);
            }
          } else {
            // In theory, this is the only case where we might not have a transceiver yet
            audioTransceiver = config.pc.addTransceiver('audio', { direction: 'recvonly' });
            Janus.log('Adding recvonly audio transceiver:', audioTransceiver);
          }
        }
      }
      // Handle video (and related changes, if any)
      const videoSend = isVideoSendEnabled(media);
      const videoRecv = isVideoRecvEnabled(media);
      if (!videoSend && !videoRecv) {
        // Video disabled: have we removed it?
        if (media.removeVideo && videoTransceiver) {
          try {
            if (videoTransceiver.setDirection) {
              videoTransceiver.setDirection('inactive');
            } else {
              videoTransceiver.direction = 'inactive';
            }
            Janus.log('Setting video transceiver to inactive:', videoTransceiver);
          } catch (e) {
            Janus.error(e);
          }
        }
      } else {
        // Take care of video m-line
        if (videoSend && videoRecv) {
          if (videoTransceiver) {
            try {
              if (videoTransceiver.setDirection) {
                videoTransceiver.setDirection('sendrecv');
              } else {
                videoTransceiver.direction = 'sendrecv';
              }
              Janus.log('Setting video transceiver to sendrecv:', videoTransceiver);
            } catch (e) {
              Janus.error(e);
            }
          }
        } else if (videoSend && !videoRecv) {
          if (videoTransceiver) {
            try {
              if (videoTransceiver.setDirection) {
                videoTransceiver.setDirection('sendonly');
              } else {
                videoTransceiver.direction = 'sendonly';
              }
              Janus.log('Setting video transceiver to sendonly:', videoTransceiver);
            } catch (e) {
              Janus.error(e);
            }
          }
        } else if (!videoSend && videoRecv) {
          if (videoTransceiver) {
            try {
              if (videoTransceiver.setDirection) {
                videoTransceiver.setDirection('recvonly');
              } else {
                videoTransceiver.direction = 'recvonly';
              }
              Janus.log('Setting video transceiver to recvonly:', videoTransceiver);
            } catch (e) {
              Janus.error(e);
            }
          } else {
            // In theory, this is the only case where we might not have a transceiver yet
            videoTransceiver = config.pc.addTransceiver('video', { direction: 'recvonly' });
            Janus.log('Adding recvonly video transceiver:', videoTransceiver);
          }
        }
      }
    } else if (Janus.webRTCAdapter.browserDetails.browser === 'firefox' || Janus.webRTCAdapter.browserDetails.browser === 'edge') {
      mediaConstraints = {
        offerToReceiveAudio: isAudioRecvEnabled(media),
        offerToReceiveVideo: isVideoRecvEnabled(media),
      };
    } else {
      mediaConstraints = {
        mandatory: {
          OfferToReceiveAudio: isAudioRecvEnabled(media),
          OfferToReceiveVideo: isVideoRecvEnabled(media),
        },
      };
    }
    Janus.debug(mediaConstraints);
    // Check if this is Firefox and we've been asked to do simulcasting
    config.pc.createAnswer(mediaConstraints)
      .then((answer) => {
        Janus.debug(answer);
        // JSON.stringify doesn't work on some WebRTC objects anymore
        // See https://code.google.com/p/chromium/issues/detail?id=467366
        const jsep = {
          type: answer.type,
          sdp: answer.sdp,
        };
        callbacks.customizeSdp(jsep);
        answer.sdp = jsep.sdp;
        Janus.log('Setting local description');
        config.mySdp = answer.sdp;
        config.pc.setLocalDescription(answer)
          .catch(callbacks.error);
        config.mediaConstraints = mediaConstraints;
        if (!config.iceDone && !config.trickle) {
          // Don't do anything until we have all candidates
          Janus.log('Waiting for all candidates...');
          return;
        }
        callbacks.success(answer);
      }, callbacks.error);
  }

  function sendSDP(handleId, callbacks) {
    callbacks = callbacks || {};
    callbacks.success = (typeof callbacks.success === 'function') ? callbacks.success : Janus.noop;
    callbacks.error = (typeof callbacks.error === 'function') ? callbacks.error : Janus.noop;
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || !pluginHandle.webrtcStuff) {
      Janus.warn('Invalid handle, not sending anything');
      return;
    }
    const config = pluginHandle.webrtcStuff;
    Janus.log('Sending offer/answer SDP...');
    if (!config.mySdp) {
      Janus.warn('Local SDP instance is invalid, not sending anything...');
      return;
    }
    config.mySdp = {
      type: config.pc.localDescription.type,
      sdp: config.pc.localDescription.sdp,
    };
    if (config.trickle === false) {
      config.mySdp.trickle = false;
    }
    Janus.debug(callbacks);
    config.sdpSent = true;
    callbacks.success(config.mySdp);
  }

  function getVolume(handleId, remote) {
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || !pluginHandle.webrtcStuff) {
      Janus.warn('Invalid handle');
      return 0;
    }
    const stream = remote ? 'remote' : 'local';
    const config = pluginHandle.webrtcStuff;
    if (!config.volume[stream]) {
      config.volume[stream] = { value: 0 };
    }
    // Start getting the volume, if getStats is supported
    if (config.pc.getStats && Janus.webRTCAdapter.browserDetails.browser === 'chrome') {
      if (remote && !config.remoteStream) {
        Janus.warn('Remote stream unavailable');
        return 0;
      } else if (!remote && !config.myStream) {
        Janus.warn('Local stream unavailable');
        return 0;
      }
      if (!config.volume[stream].timer) {
        Janus.log(`Starting ${stream} volume monitor`);
        config.volume[stream].timer = setInterval(() => {
          config.pc.getStats()
            .then((stats) => {
              const results = stats.result();
              for (let i = 0; i < results.length; i++) {
                const res = results[i];
                if (res.type == 'ssrc') {
                  if (remote && res.stat('audioOutputLevel')) {
                    config.volume[stream].value = parseInt(res.stat('audioOutputLevel'));
                  } else if (!remote && res.stat('audioInputLevel')) {
                    config.volume[stream].value = parseInt(res.stat('audioInputLevel'));
                  }
                }
              }
            });
        }, 200);
        return 0;	// We don't have a volume to return yet
      }
      return config.volume[stream].value;
    }
    // audioInputLevel and audioOutputLevel seem only available in Chrome? audioLevel
    // seems to be available on Chrome and Firefox, but they don't seem to work
    Janus.warn(`Getting the ${stream} volume unsupported by browser`);
    return 0;
  }

  function isMuted(handleId, video) {
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || !pluginHandle.webrtcStuff) {
      Janus.warn('Invalid handle');
      return true;
    }
    const config = pluginHandle.webrtcStuff;
    if (!config.pc) {
      Janus.warn('Invalid PeerConnection');
      return true;
    }
    if (!config.myStream) {
      Janus.warn('Invalid local MediaStream');
      return true;
    }
    if (video) {
      // Check video track
      if (!config.myStream.getVideoTracks() || config.myStream.getVideoTracks().length === 0) {
        Janus.warn('No video track');
        return true;
      }
      return !config.myStream.getVideoTracks()[0].enabled;
    }
    // Check audio track
    if (!config.myStream.getAudioTracks() || config.myStream.getAudioTracks().length === 0) {
      Janus.warn('No audio track');
      return true;
    }
    return !config.myStream.getAudioTracks()[0].enabled;
  }

  function mute(handleId, video, mute) {
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || !pluginHandle.webrtcStuff) {
      Janus.warn('Invalid handle');
      return false;
    }
    const config = pluginHandle.webrtcStuff;
    if (!config.pc) {
      Janus.warn('Invalid PeerConnection');
      return false;
    }
    if (!config.myStream) {
      Janus.warn('Invalid local MediaStream');
      return false;
    }
    if (video) {
      // Mute/unmute video track
      if (!config.myStream.getVideoTracks() || config.myStream.getVideoTracks().length === 0) {
        Janus.warn('No video track');
        return false;
      }
      config.myStream.getVideoTracks()[0].enabled = !mute;
      return true;
    }
    // Mute/unmute audio track
    if (!config.myStream.getAudioTracks() || config.myStream.getAudioTracks().length === 0) {
      Janus.warn('No audio track');
      return false;
    }
    config.myStream.getAudioTracks()[0].enabled = !mute;
    return true;
  }

  function getBitrate(handleId) {
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle || !pluginHandle.webrtcStuff) {
      Janus.warn('Invalid handle');
      return 'Invalid handle';
    }
    const config = pluginHandle.webrtcStuff;
    if (!config.pc) {
      return 'Invalid PeerConnection';
    }
    // Start getting the bitrate, if getStats is supported
    Janus.warn('Getting the video bitrate unsupported by browser');
    return 'Feature unsupported by browser';
  }

  function webrtcError(error) {
    Janus.error('WebRTC error:', error);
  }

  function cleanupWebrtc(handleId, hangupRequest) {
    Janus.log('Cleaning WebRTC stuff');
    const pluginHandle = pluginHandles[handleId];
    if (!pluginHandle) {
      // Nothing to clean
      return;
    }
    const config = pluginHandle.webrtcStuff;
    if (config) {
      if (hangupRequest === true) {
        // Send a hangup request (we don't really care about the response)
        const request = { janus: 'hangup', transaction: Janus.randomString(12) };
        if (pluginHandle.token) {
          request.token = pluginHandle.token;
        }
        if (apisecret) {
          request.apisecret = apisecret;
        }
        Janus.debug(`Sending hangup request (handle=${handleId}):`);
        Janus.debug(request);
        if (websockets) {
          request.session_id = sessionId;
          request.handle_id = handleId;
          ws.send(JSON.stringify(request));
        } else {
          Janus.httpAPICall(`${server}/${sessionId}/${handleId}`, {
            verb: 'POST',
            withCredentials,
            body: request,
          });
        }
      }
      // Cleanup stack
      config.remoteStream = null;
      if (config.volume) {
        if (config.volume.local && config.volume.local.timer) {
          clearInterval(config.volume.local.timer);
        }
        if (config.volume.remote && config.volume.remote.timer) {
          clearInterval(config.volume.remote.timer);
        }
      }
      config.volume = {};
      if (config.bitrate.timer) {
        clearInterval(config.bitrate.timer);
      }
      config.bitrate.timer = null;
      config.bitrate.bsnow = null;
      config.bitrate.bsbefore = null;
      config.bitrate.tsnow = null;
      config.bitrate.tsbefore = null;
      config.bitrate.value = null;
      try {
        // Try a MediaStreamTrack.stop() for each track
        if (!config.streamExternal && config.myStream) {
          Janus.log('Stopping local stream tracks');
          const tracks = config.myStream.getTracks();
          for (const mst of tracks) {
            Janus.log(mst);
            if (mst) {
              mst.stop();
            }
          }
        }
      } catch (e) {
        // Do nothing if this fails
      }
      config.streamExternal = false;
      config.myStream = null;
      // Close PeerConnection
      try {
        config.pc.close();
      } catch (e) {
        // Do nothing
      }
      config.pc = null;
      config.candidates = null;
      config.mySdp = null;
      config.remoteSdp = null;
      config.iceDone = false;
      config.dataChannel = {};
      config.dtmfSender = null;
    }
    pluginHandle.oncleanup();
  }

  // Helper method to munge an SDP to enable simulcasting (Chrome only)
  function mungeSdpForSimulcasting(sdp) {
    // Let's munge the SDP to add the attributes for enabling simulcasting
    // (based on https://gist.github.com/ggarber/a19b4c33510028b9c657)
    const lines = sdp.split('\r\n');
    let video = false;
    let ssrc = [-1],
      ssrc_fid = [-1];
    let cname = null,
      msid = null,
      mslabel = null,
      label = null;
    let insertAt = -1;
    for (var i = 0; i < lines.length; i++) {
      var mline = lines[i].match(/m=(\w+) */);
      if (mline) {
        var medium = mline[1];
        if (medium === 'video') {
          // New video m-line: make sure it's the first one
          if (ssrc[0] < 0) {
            video = true;
          } else {
            // We're done, let's add the new attributes here
            insertAt = i;
            break;
          }
        } else {
          // New non-video m-line: do we have what we were looking for?
          if (ssrc[0] > -1) {
            // We're done, let's add the new attributes here
            insertAt = i;
            break;
          }
        }
        continue;
      }
      if (!video) {
        continue;
      }
      const fid = lines[i].match(/a=ssrc-group:FID (\d+) (\d+)/);
      if (fid) {
        ssrc[0] = fid[1];
        ssrc_fid[0] = fid[2];
        lines.splice(i, 1);
        i--;
        continue;
      }
      if (ssrc[0]) {
        var match = lines[i].match(`a=ssrc:${ssrc[0]} cname:(.+)`);
        if (match) {
          cname = match[1];
        }
        match = lines[i].match(`a=ssrc:${ssrc[0]} msid:(.+)`);
        if (match) {
          msid = match[1];
        }
        match = lines[i].match(`a=ssrc:${ssrc[0]} mslabel:(.+)`);
        if (match) {
          mslabel = match[1];
        }
        match = lines[i].match(`a=ssrc:${ssrc[0]} label:(.+)`);
        if (match) {
          label = match[1];
        }
        if (lines[i].indexOf(`a=ssrc:${ssrc_fid[0]}`) === 0) {
          lines.splice(i, 1);
          i--;
          continue;
        }
        if (lines[i].indexOf(`a=ssrc:${ssrc[0]}`) === 0) {
          lines.splice(i, 1);
          i--;
          continue;
        }
      }
      if (lines[i].length == 0) {
        lines.splice(i, 1);
        i--;
        continue;
      }
    }
    if (ssrc[0] < 0) {
      // Couldn't find a FID attribute, let's just take the first video SSRC we find
      insertAt = -1;
      video = false;
      for (var i = 0; i < lines.length; i++) {
        var mline = lines[i].match(/m=(\w+) */);
        if (mline) {
          var medium = mline[1];
          if (medium === 'video') {
            // New video m-line: make sure it's the first one
            if (ssrc[0] < 0) {
              video = true;
            } else {
              // We're done, let's add the new attributes here
              insertAt = i;
              break;
            }
          } else {
            // New non-video m-line: do we have what we were looking for?
            if (ssrc[0] > -1) {
              // We're done, let's add the new attributes here
              insertAt = i;
              break;
            }
          }
          continue;
        }
        if (!video) {
          continue;
        }
        if (ssrc[0] < 0) {
          const value = lines[i].match(/a=ssrc:(\d+)/);
          if (value) {
            ssrc[0] = value[1];
            lines.splice(i, 1);
            i--;
            continue;
          }
        } else {
          var match = lines[i].match(`a=ssrc:${ssrc[0]} cname:(.+)`);
          if (match) {
            cname = match[1];
          }
          match = lines[i].match(`a=ssrc:${ssrc[0]} msid:(.+)`);
          if (match) {
            msid = match[1];
          }
          match = lines[i].match(`a=ssrc:${ssrc[0]} mslabel:(.+)`);
          if (match) {
            mslabel = match[1];
          }
          match = lines[i].match(`a=ssrc:${ssrc[0]} label:(.+)`);
          if (match) {
            label = match[1];
          }
          if (lines[i].indexOf(`a=ssrc:${ssrc_fid[0]}`) === 0) {
            lines.splice(i, 1);
            i--;
            continue;
          }
          if (lines[i].indexOf(`a=ssrc:${ssrc[0]}`) === 0) {
            lines.splice(i, 1);
            i--;
            continue;
          }
        }
        if (lines[i].length == 0) {
          lines.splice(i, 1);
          i--;
          continue;
        }
      }
    }
    if (ssrc[0] < 0) {
      // Still nothing, let's just return the SDP we were asked to munge
      Janus.warn("Couldn't find the video SSRC, simulcasting NOT enabled");
      return sdp;
    }
    if (insertAt < 0) {
      // Append at the end
      insertAt = lines.length;
    }
    // Generate a couple of SSRCs (for retransmissions too)
    // Note: should we check if there are conflicts, here?
    ssrc[1] = Math.floor(Math.random() * 0xFFFFFFFF);
    ssrc[2] = Math.floor(Math.random() * 0xFFFFFFFF);
    ssrc_fid[1] = Math.floor(Math.random() * 0xFFFFFFFF);
    ssrc_fid[2] = Math.floor(Math.random() * 0xFFFFFFFF);
    // Add attributes to the SDP
    for (var i = 0; i < ssrc.length; i++) {
      if (cname) {
        lines.splice(insertAt, 0, `a=ssrc:${ssrc[i]} cname:${cname}`);
        insertAt++;
      }
      if (msid) {
        lines.splice(insertAt, 0, `a=ssrc:${ssrc[i]} msid:${msid}`);
        insertAt++;
      }
      if (mslabel) {
        lines.splice(insertAt, 0, `a=ssrc:${ssrc[i]} mslabel:${mslabel}`);
        insertAt++;
      }
      if (label) {
        lines.splice(insertAt, 0, `a=ssrc:${ssrc[i]} label:${label}`);
        insertAt++;
      }
      // Add the same info for the retransmission SSRC
      if (cname) {
        lines.splice(insertAt, 0, `a=ssrc:${ssrc_fid[i]} cname:${cname}`);
        insertAt++;
      }
      if (msid) {
        lines.splice(insertAt, 0, `a=ssrc:${ssrc_fid[i]} msid:${msid}`);
        insertAt++;
      }
      if (mslabel) {
        lines.splice(insertAt, 0, `a=ssrc:${ssrc_fid[i]} mslabel:${mslabel}`);
        insertAt++;
      }
      if (label) {
        lines.splice(insertAt, 0, `a=ssrc:${ssrc_fid[i]} label:${label}`);
        insertAt++;
      }
    }
    lines.splice(insertAt, 0, `a=ssrc-group:FID ${ssrc[2]} ${ssrc_fid[2]}`);
    lines.splice(insertAt, 0, `a=ssrc-group:FID ${ssrc[1]} ${ssrc_fid[1]}`);
    lines.splice(insertAt, 0, `a=ssrc-group:FID ${ssrc[0]} ${ssrc_fid[0]}`);
    lines.splice(insertAt, 0, `a=ssrc-group:SIM ${ssrc[0]} ${ssrc[1]} ${ssrc[2]}`);
    sdp = lines.join('\r\n');
    if (!sdp.endsWith('\r\n')) {
      sdp += '\r\n';
    }
    return sdp;
  }

  // Helper methods to parse a media object
  function isAudioSendEnabled(media) {
    Janus.debug('isAudioSendEnabled:', media);
    if (!media) {
      return true;
    }	// Default
    if (media.audio === false) {
      return false;
    }	// Generic audio has precedence
    if (media.audioSend === undefined || media.audioSend === null) {
      return true;
    }	// Default
    return (media.audioSend === true);
  }

  function isAudioSendRequired(media) {
    Janus.debug('isAudioSendRequired:', media);
    if (!media) {
      return false;
    }	// Default
    if (media.audio === false || media.audioSend === false) {
      return false;
    }	// If we're not asking to capture audio, it's not required
    if (media.failIfNoAudio === undefined || media.failIfNoAudio === null) {
      return false;
    }	// Default
    return (media.failIfNoAudio === true);
  }

  function isAudioRecvEnabled(media) {
    Janus.debug('isAudioRecvEnabled:', media);
    if (!media) {
      return true;
    }	// Default
    if (media.audio === false) {
      return false;
    }	// Generic audio has precedence
    if (media.audioRecv === undefined || media.audioRecv === null) {
      return true;
    }	// Default
    return (media.audioRecv === true);
  }

  function isVideoSendEnabled(media) {
    Janus.debug('isVideoSendEnabled:', media);
    if (!media) {
      return true;
    }	// Default
    if (media.video === false) {
      return false;
    }	// Generic video has precedence
    if (media.videoSend === undefined || media.videoSend === null) {
      return true;
    }	// Default
    return (media.videoSend === true);
  }

  function isVideoSendRequired(media) {
    Janus.debug('isVideoSendRequired:', media);
    if (!media) {
      return false;
    }	// Default
    if (media.video === false || media.videoSend === false) {
      return false;
    }	// If we're not asking to capture video, it's not required
    if (media.failIfNoVideo === undefined || media.failIfNoVideo === null) {
      return false;
    }	// Default
    return (media.failIfNoVideo === true);
  }

  function isVideoRecvEnabled(media) {
    Janus.debug('isVideoRecvEnabled:', media);
    if (!media) {
      return true;
    }	// Default
    if (media.video === false) {
      return false;
    }	// Generic video has precedence
    if (media.videoRecv === undefined || media.videoRecv === null) {
      return true;
    }	// Default
    return (media.videoRecv === true);
  }

  function isScreenSendEnabled(media) {
    Janus.debug('isScreenSendEnabled:', media);
    if (!media) {
      return false;
    }
    if (typeof media.video !== 'object' || typeof media.video.mandatory !== 'object') {
      return false;
    }
    const constraints = media.video.mandatory;
    if (constraints.chromeMediaSource) {
      return constraints.chromeMediaSource === 'desktop' || constraints.chromeMediaSource === 'screen';
    } else if (constraints.mozMediaSource) {
      return constraints.mozMediaSource === 'window' || constraints.mozMediaSource === 'screen';
    } else if (constraints.mediaSource) {
      return constraints.mediaSource === 'window' || constraints.mediaSource === 'screen';
    }
    return false;
  }

  function isDataEnabled(media) {
    Janus.debug('isDataEnabled:', media);
    if (media === undefined || media === null) {
      return false;
    }	// Default
    return (media.data === true);
  }

  function isTrickleEnabled(trickle) {
    Janus.debug('isTrickleEnabled:', trickle);
    return trickle !== false;
  }
}

Janus.init({
  debug: 'all',
  callback() {
    console.log('Janus initialized');
  },
});

module.exports = Janus;
