CREATE TABLE IF NOT EXISTS diagnoses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                          -- 管理画面表示名 例: Re'Dent 清潔感診断
  slug TEXT UNIQUE,                            -- LIFF URL 用 例: redent-cleanliness
  definition TEXT NOT NULL,                    -- 定義JSON(03_definition-schema.md 準拠)
  definition_version INTEGER NOT NULL DEFAULT 1, -- definition 更新のたびに +1
  is_active INTEGER NOT NULL DEFAULT 1,
  submit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS diagnosis_submissions (
  id TEXT PRIMARY KEY,
  diagnosis_id TEXT NOT NULL REFERENCES diagnoses (id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends (id) ON DELETE SET NULL,
  line_user_id TEXT,                           -- friend が消えても本人照合できるよう保持
  definition_version INTEGER NOT NULL,         -- 回答時点の定義バージョン
  answers TEXT NOT NULL,                       -- JSON 例: {"T1":4,"T2":5,...} (questionId -> 1..5)
  result TEXT NOT NULL,                        -- 結果スナップショットJSON(下記)
  share_token TEXT UNIQUE,                     -- 共有URL用。crypto.randomUUID() 等の推測困難な値
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 注: idx_diag_sub_diagnosis は複合 idx_diag_sub_created の先頭列で代替可のため作らない。
--     share_token は UNIQUE 制約が自動でインデックスを張るため専用 INDEX も作らない。
CREATE INDEX IF NOT EXISTS idx_diag_sub_friend    ON diagnosis_submissions (friend_id);
CREATE INDEX IF NOT EXISTS idx_diag_sub_created   ON diagnosis_submissions (diagnosis_id, created_at);
