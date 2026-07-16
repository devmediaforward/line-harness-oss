-- diagnosis_submissions.request_id — クライアント生成の冪等キー。
-- 回答送信 (POST /api/liff/diagnoses/:slug/submissions) の再送で回答が
-- 二重保存され副作用 (LINE push 等) も二重実行されるのを防ぐ。
-- UNIQUE は (diagnosis_id, request_id) の複合。冪等検索も同スコープで行うため、
-- 別診断で同じ request_id が使われても事前検索/引き直しと整合する。旧クライアント
-- 由来の NULL は SQLite の UNIQUE では互いに衝突しない (複数 NULL を許容) ため後方互換。
ALTER TABLE diagnosis_submissions ADD COLUMN request_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_diag_sub_request
  ON diagnosis_submissions (diagnosis_id, request_id);
