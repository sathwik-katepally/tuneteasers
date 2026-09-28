/* The one D1 read the room Durable Object makes: who holds a ticket. Kept
   apart from people.js so the object does not pull the WebAuthn library in. */
const TICKET_RX = /^([a-z2-7]{12})\.([A-Za-z0-9_-]{22})$/;

const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

export async function ticketHolder(env, ticket){
  const t = TICKET_RX.exec(ticket);
  if (!t || !env?.DB) return null;
  const [, id, key] = t;
  const [row, digest] = await Promise.all([
    env.DB.prepare("SELECT id, name, key_hash FROM people WHERE id = ?").bind(id).first(),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
  ]);
  if (!row || hex(new Uint8Array(digest)) !== row.key_hash) return null;
  return { id: row.id, name: row.name };
}
