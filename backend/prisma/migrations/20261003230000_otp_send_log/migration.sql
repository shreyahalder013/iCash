-- Append-only OTP send log: OtpRecord is upserted per (purpose, mobile) so it cannot be used to count sends.
CREATE TABLE IF NOT EXISTS "OtpSendLog" (
  "id" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "ip_address" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OtpSendLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "OtpSendLog_subject_created_at_idx" ON "OtpSendLog"("subject", "created_at");
CREATE INDEX IF NOT EXISTS "OtpSendLog_ip_address_created_at_idx" ON "OtpSendLog"("ip_address", "created_at");
