/** 
 * Use Redis as a key/value store.
 *
 * example config:
 * db: {
 *		type: 'redis',
 *		server: 'localhost',
 *		port: 6379,
 *		number: 0, // Which Redis database to use 
 *		password: 'foo'
 * }
 **/

var redis = require('redis'),
	url = require('url'),
	async = require('async'),
	hooks = require('hooks'),
    config = require('../../config'),
    key;

function RedisAdapter() {
	var self = this,
		options = config.db.options || {};

	// Have the client use Buffers instead of a strings for binary data
	//options.return_buffers = true;
	options.detect_buffers = true;

	this.changeChannel = 'kitcms_change';

	// Support RedisToGo on Herkou	
	if (process.env.REDISTOGO_URL) {
		// Override config.js settings
		
		var parts = url.parse(process.env.REDISTOGO_URL),
			auth = parts.auth || '';

		config.db.address = parts.hostname;
		config.db.port = parts.port;

		auth = auth.split(':');
		if (auth.length == 2)
			config.db.password = auth[1];
	}
	
	// Create Redis clients
	this.client = redis.createClient(config.db.port || 6379, config.db.address || 'localhost', options);
	this.subClient = redis.createClient(config.db.port || 6379, config.db.address || 'localhost', options);

	// Catch general errors
	self.client.on('error', function (err) {
	    self.onError(err);
	});

	self.subClient.on('error', function (err) {
	    self.onError(err);
	});

	// Listen for messages
	self.subClient.on("message", function (channel, message) {
		self.onMessage(channel, message);
	});

	if (config.db.password) 
		redisAuth();
	else if (config.db.number)
		redisSelect();
	else
		redisSubscribe();

	function redisAuth() {
		var ready = false;

		self.client.auth(config.db.password, function(err) {
			if (err)
				throw err;

			if (!ready) {
				ready = true;
				return;
			}

			if (config.db.number)
				redisSelect();
			else
				redisSubscribe();
		});

		self.subClient.auth(config.db.password, function(err) {
			if (err)
				throw err;

			if (!ready) {
				ready = true;
				return;
			}				
			
			if (config.db.number)
				redisSelect();
			else
				redisSubscribe();
		});
	}

	function redisSelect() {
		var ready = false;

		self.client.select(config.db.number, function(err) {
			if (err)
				throw err;

			if (!ready) {
				ready = true;
				return;
			}		

			redisSubscribe();
		});
		
		self.subClient.select(config.db.number, function(err) {
			if (err)
				throw err;

			if (!ready) {
				ready = true;
				return;
			}		

			redisSubscribe();
		});
	}

	function redisSubscribe() {
		// Subscribe to document changes
		self.subClient.subscribe(self.changeChannel);
	}

	return this;
}


/* Setup hooks */

for (var key in hooks) {
  RedisAdapter[key] = hooks[key];
}


/* Retrieve a document */

RedisAdapter.prototype.get = function(key, cb) {	
	this.client.get(key, function(err, doc) {
		if (err)
			return cb(err);

		if (typeof doc === 'string') {
			try {
				doc = JSON.parse(doc);
			}
			catch(e) {
				return cb(new Error('Redis: Invalid JSON data format for key ' + key));
			}
		}		
		cb(null, doc);
	});
}
RedisAdapter.hook('get', RedisAdapter.prototype.get);

/* Update or add a document */

RedisAdapter.prototype.set = function(key, doc, cb) {
	var self = this;

	if (typeof doc === 'string') {
		doc = JSON.stringify(doc);
	}

	this.client.set(key, doc, function(err) {
		self.notifyChange(key);
		if (cb)
			cb(err);
	});
}
RedisAdapter.hook('set', RedisAdapter.prototype.set);


/* Remove a document */

RedisAdapter.prototype.unset = function(key, cb) {	
	var self = this;
	this.client.del(key, function(err) {
		self.notifyChange(key);
		if (cb)
			cb(err);
	});
}
RedisAdapter.hook('unset', RedisAdapter.prototype.unset);

/* Get a list of stored document keys */

RedisAdapter.prototype.keys = function(namespace, cb) {	
	this.client.keys(namespace + '&*', function(err, keys) {
		var len = namespace.length + 1,
			i;

		if (err)
			cb(err);

		// Remove namespace from keys
		for (i = 0; i < keys.length; i++) {
			keys[i] = keys[i].substr(len);
		}

		cb(null, keys);
	});
}
RedisAdapter.hook('keys', RedisAdapter.prototype.keys);

/* Clear a namespace of all values */

RedisAdapter.prototype.clear = function(namespace, cb) {
	var self = this;

	this.client.keys(namespace + '&*', function(err, keys) {
		async.forEach(keys, processKey, function(err){
		    if (err)
		    	return cb(err);

		    cb();
		});

		function processKey(key, cb) {
			self.unset(key, cb);
		}
	});
};	
RedisAdapter.hook('clear', RedisAdapter.prototype.clear);

/* Publish a message to Redis, alerting listeners of a change to a template */

RedisAdapter.prototype.notifyChange = function(key) {
	this.client.publish(this.changeChannel, key);

	// clear css when less file is changed
	if (key.substr(key.length - 5) === '.less')
		this.unset(key.substr(0, key.length - 4) + 'css', function() {});
};

/* Handle change messages from Redis, pass them to the onChange */

RedisAdapter.prototype.onMessage = function(channel, message) {
	if (channel === this.changeChannel)
		this.onChange(message);	
};

RedisAdapter.prototype.onChange = function(key) {
	
};

RedisAdapter.prototype.onError = function(err) {
	console.log('Redis Error: ' + err);
};

module.exports = RedisAdapter;