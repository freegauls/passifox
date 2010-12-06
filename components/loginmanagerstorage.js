const Ci = Components.interfaces;
const Cu = Components.utils;
const Cc = Components.classes;

const AES_KEY_URL = "chrome://keepassfox";
const KEEPASS_HTTP_URL = "http://localhost:19455/";

const KEEPASSFOX_CACHE_TIME = 5 * 1000; // milliseconds

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/services-crypto/WeaveCrypto.js");

function LoginManagerStorage() {
    this.wrappedJSObject = this;
    XPCOMUtils.defineLazyGetter(this, "_kpf", function() {
        return new KeePassFox();
    });
}

LoginManagerStorage.prototype = {
    classDescription: "KeePassFox Login Manager Storage",
    classID:          Components.ID("{fa199659-10c4-4e3a-a73b-e2b4e1deae96}"),
    QueryInterface:   XPCOMUtils.generateQI([Ci.nsISupports,
                                             Ci.nsILoginManagerStorage]),
    uiBusy: false, // XXX seems to be needed in <=ff4.0b7
    log: function(m) {
        Services.console.logStringMessage("LoginManagerStorage: " + m);
    },
    stub: function(arguments) {
        let args = [];
        for (let i = 0; i < arguments.length; i++) {
            let arg = arguments[i];
            if (typeof(arg) == "object")
                arg = JSON.stringify(arg);
            args.push(arg);
        }
        this.log(arguments.callee.name + "(" + args.join(",") + ")");
    },

    init: function _init() { }, // don't need to init
    // ignored, no implementation
    initWithFile: function _initWithFile(inFile, outFile) { },

    // XXX TODO implement me!
    addLogin: function _addLogin(login) {
        this.stub(arguments);
        this._sendNotification("addLogin", login);
    },
    // not implemented--removals should be managed in KeePass
    removeLogin: function _removeLogin(login) {
        //this._sendNotification("removeLogin", login);
    },
    // XXX TODO implement me!
    modifyLogin: function _modifyLogin(oldlogin, newlogindata) {
        this.stub(arguments);

        let newlogin = oldlogin.clone();
        if (newlogindata instanceof Ci.nsILoginInfo) {
        } else if (newlogindata instanceof Ci.nsIPropertyBag) {
        }

        //this._sendNotifiation("modifyLogin", [oldlogin, newlogin]);
    },
    getAllLogins: function _getAllLogins(outCount) {
        let entries = this._kpf.get_all_logins();
        outCount.value = entries.length;
        let logins = [];
        for (let i = 0; i < entries.length; i++) {
            let l = Cc['@mozilla.org/login-manager/loginInfo;1']
                    .createInstance(Ci.nsILoginInfo);
            l.hostname = entries[i].Name;
            l.username = entries[i].Login;
            l.password = "Stored in KeePass";
            l.usernameField = "";
            l.passwordField = "";
            l.QueryInterface(Ci.nsILoginMetaInfo);
            l.guid = entries[i].Uuid;
            logins.push(l);
        }
        return logins;
    },
    getAllEncryptedLogins: function _getAllEncryptedLogins(outCount) {
        return this.getAllLogins(outCount);
    },
    searchLogins: function _searchLogins(count, matchData) {
        // this appears to be used by weave/sync, don't need it
        outCount.value = 0;
        return [];
    },

    removeAllLogins: function() { }, // never, ever do this
    // hosts are never disabled
    getAllDisabledHosts: function(outCount) {
        outCount.value = 0;
        return [];
    },
    getLoginSavingEnabled: function(hostname) { return true; }, // always true
    setLoginSavingEnabled: function(hostname, enabled) { }, // ignore

    findLogins: function _findLogins(outCount, hostname, submitURL, realm) {
        let entries = this._kpf.get_logins(hostname, submitURL);
        outCount.value = entries.length;
        let logins = [];
        for (let i = 0; i < entries.length; i++) {
            let l = Cc['@mozilla.org/login-manager/loginInfo;1']
                    .createInstance(Ci.nsILoginInfo);
            l.hostname      = hostname;
            l.formSubmitURL = submitURL;
            l.username      = entries[i].Login;
            l.password      = entries[i].Password;
            l.usernameField = "";
            l.passwordField = "";
            l.QueryInterface(Ci.nsILoginMetaInfo);
            l.guid = entries[i].Uuid;
            logins.push(l);
        }
        return logins;
    },
    countLogins: function _countLogins(hostname, submitURL, realm) {
        let c = this._kpf.get_logins_count(hostname);
        return c;
    },
    // copied from storage-mozStorage.js
    _sendNotification: function(changeType, data) {
        let dataObject = data;
        // Can't pass a raw JS string or array though notifyObservers(). :-(
        if (data instanceof Array) {
            dataObject = Cc["@mozilla.org/array;1"].
                         createInstance(Ci.nsIMutableArray);
            for (let i = 0; i < data.length; i++)
                dataObject.appendElement(data[i], false);
        } else if (typeof(data) == "string") {
            dataObject = Cc["@mozilla.org/supports-string;1"].
                         createInstance(Ci.nsISupportsString);
            dataObject.data = data;
        }
        Services.obs.notifyObservers(dataObject,
                "passwordmgr-storage-changed", changeType);
    },
};

const NSGetFactory = XPCOMUtils.generateNSGetFactory([LoginManagerStorage]);

function KeePassFox() {
    XPCOMUtils.defineLazyGetter(this, "_mozStorage", function() {
        let contract = "@mozilla.org/login-manager/storage/mozStorage;1";
        let storage = Cc[contract].createInstance(Ci.nsILoginManagerStorage);
        storage.init();
        return storage;
    });
    XPCOMUtils.defineLazyGetter(this, "_crypto", function() {
        return new WeaveCrypto();
    });
}

KeePassFox.prototype = {
    _associated: false,
    log: function(m) {
        Services.console.logStringMessage("LoginManagerStorage: " + m);
    },
    _cache: { }, // use a cache to throttle get_logins requests
    _set_crypto_key: function(id, key) {
        let storage = this._mozStorage;
        let logins = storage.findLogins({}, AES_KEY_URL, null, null);
        for (let i = 0; i < logins.length; i++) {
            storage.removeLogin(logins[i]);
        }
        this.log("Storing key in mozStorage");
        let l = Cc['@mozilla.org/login-manager/loginInfo;1']
                .createInstance(Ci.nsILoginInfo);
        l.hostname = AES_KEY_URL;
        l.username = id;
        l.password = key;
        l.usernameField = "";
        l.passwordField = "";
        storage.addLogin(l);
    },
    _find_cache_item: function(url, submiturl) {
        let key = url + "!!" + submiturl;
        let item = this._cache[key];
        let now = Date.now();
        if (item && (item.ts + KEEPASSFOX_CACHE_TIME) > now) {
            item.ts = now;
            return item.entries;
        }
        return null;
    },
    _cache_item: function(url, submiturl, entries) {
        let key = url + "!!" + submiturl;
        let item = {};
        item.ts = Date.now();
        item.entries = entries;
        this._cache[key] = item;
    },
    _prune_cache: function() {
        let now = Date.now();
        for (let i in this._cache) {
            let item = this._cache[i];
            if ((item.ts + KEEPASSFOX_CACHE_TIME) < now)
                delete this._cache[i];
        }
    },
    get_logins: function(url, submiturl) {
        let cached = this._find_cache_item(url, submiturl);
        if (cached)
            return cached;

        if (!this._test_associate())
            return;

        let request = {
            RequestType: "get-logins",
        };
        let [id, key] = this._set_verifier(request);
        request.Url = this._crypto.encrypt(url, key, request.Nonce);
        request.SubmitUrl = this._crypto.encrypt(submiturl, key, request.Nonce);
        let [s, response] = this._send(request);
        let entries = [];
this.log("response: " + response);
this.log("s: " + s);
        if (this._success(s)) {
            let r = JSON.parse(response);
            if (this._verify_response(r, key, id)) {
                let iv = r.Nonce;
                for (let i = 0; i < r.Entries.length; i++) {
                    this._decrypt_entry(r.Entries[i], key, iv);
                }
                entries = r.Entries;
                this._cache_item(url, submiturl, entries);
            } else {
                this.log("get_logins for " + url + " rejected");
            }
        } else {
            this.log("Request not success: " + s);
        }
        return entries;
    },
    get_logins_count: function(url) {
        this._prune_cache();
        if (!this._test_associate())
            return;
        let request = {
            RequestType: "get-logins-count",
        };
        let [id, key] = this._set_verifier(request);
        request.Url = this._crypto.encrypt(url, key, request.Nonce);
        let [s, response] = this._send(request);
        let entries = [];
this.log("s: " + s);
this.log("r: " + response);
        if (this._success(s)) {
            let r = JSON.parse(response);
            if (this._verify_response(r, key, id))
                return r.Count;
        }
        return 0;
    },
    get_all_logins: function() {
        if (!this._test_associate())
            return;
        let request = {
            RequestType: "get-all-logins",
        };
        let [id, key] = this._set_verifier(request);
        let [s, response] = this._send(request);
        let entries = [];
        if (this._success(s)) {
            let r = JSON.parse(response);
            if (!this._verify_response(r, key, id))
                return entries;
            let iv = r.Nonce;
            for (let i = 0; i < r.Entries.length; i++) {
                this._decrypt_entry(r.Entries[i], key, iv);
            }
            entries = r.Entries;
        }
        return entries;
    },

    _decrypt_entry: function(e, key, iv) {
        e.Login = this._crypto.decrypt(e.Login, key, iv);
        e.Uuid  = this._crypto.decrypt(e.Uuid,  key, iv);
        e.Name  = this._crypto.decrypt(e.Name,  key, iv);
        if (e.Password) {
            e.Password  = this._crypto.decrypt(e.Password,  key, iv);
        }
    },

    _get_crypto_key: function() {
        let storage = this._mozStorage;
        let l = storage.findLogins({}, AES_KEY_URL, null, null);
        let kpf = this;
        if (l.length == 0) {
            this._showNotification("KeePassFox has not been configured",
                    [{ accessKey: "c", label: "Connect",
                       callback: function(n, b) {
                           kpf._associate();
                       } }]);
        }
        return l.length > 0 ? [l[0].username, l[0].password] : null;
    },
    _showNotification: function(m, buttons) {
        let win     = Services.wm.getMostRecentWindow("navigator:browser");
        let browser = win.gBrowser;
        let box     = browser.getNotificationBox(browser.selectedBrowser);
        let n       = box.appendNotification(m, null,
                "chrome://keepassfox/skin/keepass.png", 3, buttons);
        // let the notification show for 30 seconds
        n.timeout = Date.now() + 30 * 1000;
    },
    _test_associate: function() {
        if (this._associated)
            return true;
        let request = {
                RequestType: "test-associate",
        };
        let info = this._set_verifier(request);
        if (!info)
            return false;

        let [id, key] = info;

        let [s, response] = this._send(request);
        if (this._success(s)) {
            let r = JSON.parse(response);
            if (!this._verify_response(r, key, id)) {
                let kpf = this;
                this._showNotification(
                        "KeePassFox encryption key is unrecognized",
                        [{ accessKey: "c", label: "Re-connect to KeePass",
                           callback: function(n, b) {
                               kpf._associate();
                         } }]);
            }
        }
        return this._associated;
    },
    _associate: function() {
        if (this._associated)
            return;
        let key = this._crypto.generateRandomKey();
        let request = {
                RequestType: "associate",
                Key:         key,
        };
        this._set_verifier(request, key);
        let [s, response] = this._send(request);
        if (this._success(s)) {
            let r = JSON.parse(response);
            let id = r.Id;
            if (!this._verify_response(r, key)) {
                let kpf = this;
                this._showNotification("KeePass association failed",
                    [{ accessKey: "t", label: "Try Again",
                       callback: function(n, b) {
                           kpf._associate();
                       } }]);
                return;
            }
            this._set_crypto_key(id, key);
            this._showNotification("KeePassFox association completed");
            this._associated = true;
        }
    },
    _verify_response: function(response, key, id) {
         if (!response.Success)
             return false;
         let iv      = response.Nonce;
         let crypted = response.Verifier;
         let value   = this._crypto.decrypt(crypted, key, iv);

         this._associated = value == iv;
         if (id) {
             this._associated = this._associated && id == response.Id;
         }
         return this._associated;
    },
    _set_verifier: function(request, inkey) {
         let key = null;
         let id  = null;

         if (inkey) {
             key = inkey;
         } else {
             let info = this._get_crypto_key();
             if (info == null) {
                 return null;
              }
             [id, key] = info;
         }
         if (id)
              request.Id = id;

         let iv           = this._crypto.generateRandomIV();
         request.Nonce    = iv;
         request.Verifier = this._crypto.encrypt(iv, key, iv);
         return [id, key];
    },
    _send: function(request) {
        let xhr = Cc["@mozilla.org/xmlextras/xmlhttprequest;1"]
                .createInstance(Ci.nsIXMLHttpRequest);
        xhr.open("POST", KEEPASS_HTTP_URL, false);
        xhr.setRequestHeader("Content-Type", "application/json");
        try {
            xhr.send(JSON.stringify(request));
        }
        catch (e) { this.log("KeePassHttp: " + e); }
        return [xhr.status, xhr.responseText];
    },
    _success: function(s) {
        let success = s >= 200 && s <= 299;
        if (!success) {
            if (s == 503)
                this._showNotification("KeePass database is not open");
            else if (s == 0)
                this._showNotification("KeePassHttp is not running");
            else
                this._showNotification("Unknown KeePassHttp error: " + s);
        }
        return success;
    },
};