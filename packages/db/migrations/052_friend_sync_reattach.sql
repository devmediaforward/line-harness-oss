-- friend_sync_reattach — PUT /api/friend-sync/:lineUserId の reattach を「(友だち, タグ, key) ごとに 1 回」に保つ記録。
-- 外部システム(店舗システム)が来店ごとの key を付けてタグの付け直しを依頼する。
-- INSERT OR IGNORE の変更行数で「この要求が最初か」を判定し、同時に 2 つ届いても付け直しは 1 回だけになる。
-- claim_id は要求ごとの乱数。同じバッチ内の後続の文が「自分が記録した行か」を EXISTS で確かめる(負けた要求は何もしない)。
-- 友だち・タグの削除に連動して消える。
CREATE TABLE IF NOT EXISTS friend_sync_reattach (
  friend_id    TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  tag_id       TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  reattach_key TEXT NOT NULL,
  claim_id     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (friend_id, tag_id, reattach_key)
);
