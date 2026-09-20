import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { DEFAULT_RETENTION_MS } from './redemption.mjs';

const claimId = key => createHash('sha256').update(String(key)).digest('hex');
const EXPIRY_GRACE_MS = 60_001;

export async function createPostgresRedemptionStore({ url } = {}) {
  const retentionMs = DEFAULT_RETENTION_MS;
  const sql = postgres(url, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 20,
    connection: { application_name: 'mtok-relay', statement_timeout: 5000, lock_timeout: 5000, synchronous_commit: 'on' },
    onnotice() {},
  });
  const expiryMs = retentionMs + EXPIRY_GRACE_MS;
  let initialized = false;
  try {
    await sql.begin(async tx => {
      // IF NOT EXISTS alone can race on PostgreSQL's catalog during parallel boots.
      await tx`select pg_advisory_xact_lock(hashtext('mtok_redemptions_v1'))`;
      await tx`
        create table if not exists mtok_redemptions (
            claimkey text primary key
          , state text not null check (state in ('pending', 'complete'))
          , payload jsonb
          , expiresat timestamptz not null
          , check ((state = 'pending' and payload is null) or (state = 'complete' and payload is not null))
        )
      `;
      await tx`create index if not exists mtok_redemptions_expiry on mtok_redemptions (expiresat)`;
      await tx`
        create table if not exists mtok_redemption_keys (
            keyid text primary key
          , claimkey text not null references mtok_redemptions (claimkey) on delete cascade
        )
      `;
      await tx`create index if not exists mtok_redemption_keys_claim on mtok_redemption_keys (claimkey)`;
      // The verifier rejects unknown payments older than retention. Keep markers
      // beyond its permitted future-clock skew, and bound each startup's cleanup.
      await tx`
        delete from mtok_redemptions
        where
          claimkey in (
          select claimkey from mtok_redemptions
          where expiresat < current_timestamp
          order by expiresat
          limit 256
        )
      `;
    });
    initialized = true;
  } finally {
    if (!initialized) await sql.end({ timeout: 1 });
  }

  const store = {
    durable: true,
    retentionMs,
    async state(key) {
      const [row] = await sql`
        select
          r.state
        from
          mtok_redemption_keys k
          join mtok_redemptions r on
            r.claimkey = k.claimkey
        where
          k.keyid = ${claimId(key)}
      `;
      return row?.state ?? null;
    },
    async get(key) {
      const [row] = await sql`
        select
          r.payload
        from
          mtok_redemption_keys k
          join mtok_redemptions r on
            r.claimkey = k.claimkey
            and r.state = 'complete'
        where
          k.keyid = ${claimId(key)}
      `;
      return row?.payload;
    },
    async claim(key, markerKey = key) {
      const id = claimId(key);
      // The core supplies the legacy marker explicitly. Parsing a prefix would
      // confuse a scheme with a booking name that happens to start the same way.
      if (markerKey !== key && key !== `legacy-v0:${markerKey}`) throw new TypeError('redemption marker does not match its claim');
      const aliases = [...new Set([id, claimId(markerKey)])].sort();
      try {
        await sql.begin(async tx => {
          await tx`
            insert into mtok_redemptions (claimkey, state, expiresat)
            values (${id}, 'pending', current_timestamp + ${expiryMs} * interval '1 millisecond')
          `;
          await tx`
            insert into mtok_redemption_keys (keyid, claimkey)
            select
                unnest(${aliases}::text[])
              , ${id}
          `;
        });
        return true;
      } catch (error) {
        if (error.code === '23505' && ['mtok_redemptions_pkey', 'mtok_redemption_keys_pkey'].includes(error.constraint_name)) return false;
        throw error;
      }
    },
    async complete(key, payload) {
      const rows = await sql`
        update mtok_redemptions
        set payload = ${sql.json(payload)}
          , state = 'complete'
          , expiresat = current_timestamp + ${expiryMs} * interval '1 millisecond'
        where
          claimkey = (select claimkey from mtok_redemption_keys where keyid = ${claimId(key)})
          and state = 'pending'
        returning claimkey
      `;
      if (rows.length !== 1) throw new Error('redemption is not pending');
    },
    async importRecord({ key, state, payload }) {
      if (!['pending', 'complete'].includes(state)) throw new TypeError('invalid imported redemption state');
      if (state === 'complete' && payload == null) throw new TypeError('completed redemption needs a payload');
      await store.claim(key);
      if (state === 'pending') return;
      await sql.begin(async tx => {
        const [existing] = await tx`
          select
            r.claimkey
          from
            mtok_redemption_keys k
            join mtok_redemptions r on
              r.claimkey = k.claimkey
          where
            k.keyid = ${claimId(key)}
          for update of r
        `;
        await tx`
          update mtok_redemptions
          set state = 'complete', payload = ${tx.json(payload)}
          where
            claimkey = ${existing.claimkey}
            and state = 'pending'
        `;
        const [row] = await tx`
          select
            payload = ${tx.json(payload)} as matches
          from
            mtok_redemptions
          where
            claimkey = ${existing.claimkey}
        `;
        if (!row.matches) throw new Error('conflicting completed redemption records');
      });
    },
    close() { return sql.end({ timeout: 5 }); },
  };
  return store;
}
