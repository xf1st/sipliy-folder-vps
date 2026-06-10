// Server-Sent Events broker — per-user client registry
const clients = new Map(); // username → Set<res>

function addClient(username, res) {
  if (!clients.has(username)) clients.set(username, new Set());
  clients.get(username).add(res);
}

function removeClient(username, res) {
  const set = clients.get(username);
  if (!set) return;
  set.delete(res);
  if (!set.size) clients.delete(username);
}

// Send named event to all connections of one user
function emit(username, event, data) {
  const set = clients.get(username);
  if (!set || !set.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch { set.delete(res); }
  }
}

// Active connection count (useful for debug)
function count() {
  let n = 0;
  for (const set of clients.values()) n += set.size;
  return n;
}

module.exports = { addClient, removeClient, emit, count };
