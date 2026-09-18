/**
 * com.fmb.tools.localdb — KV-backed document store.
 *
 * Why KV instead of SQLite?
 *   The FMB plugin sandbox blocks all native Node modules (fs, better-sqlite3,
 *   etc.). Plugins cannot create or open their own .db file. The host KV store
 *   (kv_store table inside fmb.db, located in the app data directory) is the
 *   only persistent storage available. This atomic wraps KV into a small
 *   document-collection API so the uploader app can treat tasks like rows.
 *
 * Storage layout:
 *   Each collection is a JSON array stored at KV key `db:<collection>`.
 *   Documents are plain objects; an `_id` string is assigned on insert.
 *
 * Exports (callable via hostApi.plugins.invoke):
 *   init()                          -> { ok }
 *   insert(collection, doc)         -> doc with _id
 *   update(collection, id, patch)   -> updated doc
 *   find(collection, query?)        -> doc[]
 *   findOne(collection, id)         -> doc | null
 *   remove(collection, id)          -> { ok }
 *   count(collection)               -> number
 */
/* global hostApi */

var COLLECTIONS_KEY = 'db:__collections__';

function _key(coll) { return 'db:' + coll; }

function _genId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

async function _readColl(coll) {
  var raw = await hostApi.kv.get(_key(coll));
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) {
    hostApi.logger.warn('localdb: corrupt collection JSON, resetting', { collection: coll, error: String(e && e.message || e) });
    return [];
  }
}

async function _writeColl(coll, docs) {
  await hostApi.kv.set(_key(coll), JSON.stringify(docs));
}

module.exports = {
  activate(ctx) {
    ctx.hostApi.logger.info('localdb activated', { pluginId: ctx.pluginId });
  },

  deactivate() {
    hostApi.logger.info('localdb deactivated', {});
  },

  /** Ensure the collections registry exists. No-op if already initialized. */
  async init() {
    var raw = await hostApi.kv.get(COLLECTIONS_KEY);
    if (!raw) {
      await hostApi.kv.set(COLLECTIONS_KEY, JSON.stringify({ collections: [] }));
    }
    return { ok: true };
  },

  /** Insert a document. Assigns _id if absent. Returns the stored doc. */
  async insert(payload) {
    var coll = payload && payload.collection;
    var doc = payload && payload.doc;
    if (!coll || typeof coll !== 'string') throw new Error('insert: collection required');
    if (!doc || typeof doc !== 'object') throw new Error('insert: doc object required');
    var docs = await _readColl(coll);
    var stored = Object.assign({}, doc);
    if (!stored._id) stored._id = _genId();
    stored._createdAt = Date.now();
    docs.push(stored);
    await _writeColl(coll, docs);
    return stored;
  },

  /** Patch fields on the document with the given _id. Returns updated doc or null. */
  async update(payload) {
    var coll = payload.collection;
    var id = payload.id;
    var patch = payload.patch;
    if (!coll || !id) throw new Error('update: collection and id required');
    var docs = await _readColl(coll);
    var idx = -1;
    for (var i = 0; i < docs.length; i++) {
      if (docs[i]._id === id) { idx = i; break; }
    }
    if (idx < 0) return null;
    docs[idx] = Object.assign({}, docs[idx], patch, { _id: docs[idx]._id, _updatedAt: Date.now() });
    await _writeColl(coll, docs);
    return docs[idx];
  },

  /** Find all docs matching the optional query (simple AND field equality). */
  async find(payload) {
    var coll = payload.collection;
    var query = payload.query || {};
    var docs = await _readColl(coll);
    if (!query || Object.keys(query).length === 0) return docs;
    var keys = Object.keys(query);
    return docs.filter(function (d) {
      for (var i = 0; i < keys.length; i++) {
        if (d[keys[i]] !== query[keys[i]]) return false;
      }
      return true;
    });
  },

  /** Get a single document by _id. */
  async findOne(payload) {
    var coll = payload.collection;
    var id = payload.id;
    var docs = await _readColl(coll);
    for (var i = 0; i < docs.length; i++) {
      if (docs[i]._id === id) return docs[i];
    }
    return null;
  },

  /** Remove a document by _id. */
  async remove(payload) {
    var coll = payload.collection;
    var id = payload.id;
    var docs = await _readColl(coll);
    var next = docs.filter(function (d) { return d._id !== id; });
    await _writeColl(coll, next);
    return { ok: true };
  },

  /** Count documents in a collection. */
  async count(payload) {
    var coll = payload.collection;
    var docs = await _readColl(coll);
    return docs.length;
  },
};
