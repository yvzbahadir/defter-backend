const { Pool } = require('pg');

// Neon (veya başka bir Postgres sağlayıcısı) bağlantı adresi .env'den okunur.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const DEFAULT_DATA = {
  transactions: [],
  installments: [],
  cards: [],
  categories: {
    gelir: ['Maaş', 'Reels Geliri', 'Freelance', 'Yatırım', 'Diğer'],
    gider: ['Kira', 'Fatura', 'Market', 'Ulaşım', 'Araç', 'Eğlence', 'Sağlık', 'Diğer'],
    taksit: ['Araç', 'Elektronik', 'Ev Eşyası', 'Eğitim', 'Diğer']
  },
  recurring: [],
  budgets: {}
};

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  const { rows } = await pool.query('SELECT id FROM app_state WHERE id = 1');
  if (rows.length === 0) {
    await pool.query('INSERT INTO app_state (id, data) VALUES (1, $1)', [DEFAULT_DATA]);
  }
}

async function getData() {
  const { rows } = await pool.query('SELECT data FROM app_state WHERE id = 1');
  if (rows.length === 0) {
    await pool.query('INSERT INTO app_state (id, data) VALUES (1, $1)', [DEFAULT_DATA]);
    return DEFAULT_DATA;
  }
  return rows[0].data;
}

async function setData(data) {
  await pool.query(
    'UPDATE app_state SET data = $1, updated_at = now() WHERE id = 1',
    [data]
  );
}

module.exports = { init, getData, setData, pool, DEFAULT_DATA };
