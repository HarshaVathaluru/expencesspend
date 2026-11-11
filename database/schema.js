/**
 * PaisaPilot Normalized Relational Schema & Migrations
 * Supports both PostgreSQL (production) and SQLite (zero-config local/single-node).
 * All monetary amounts are stored as integer paise (1 INR = 100 paise).
 */

const SQLITE_MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE IF NOT EXISTS user_settings (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
        currency TEXT NOT NULL DEFAULT 'INR',
        locale TEXT NOT NULL DEFAULT 'en-IN',
        theme TEXT NOT NULL DEFAULT 'dark',
        enable_3d INTEGER NOT NULL DEFAULT 1,
        reduced_motion INTEGER NOT NULL DEFAULT 0,
        daily_email_enabled INTEGER NOT NULL DEFAULT 0,
        daily_email_time TEXT NOT NULL DEFAULT '23:00',
        email_recipient TEXT,
        email_verified INTEGER NOT NULL DEFAULT 0,
        email_verification_code TEXT,
        budget_rollover_enabled INTEGER NOT NULL DEFAULT 0,
        budget_reset_day INTEGER NOT NULL DEFAULT 1,
        data_retention_days INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'expense',
        color TEXT NOT NULL DEFAULT '#38BDF8',
        icon_path TEXT NOT NULL DEFAULT '/images/categories/uncategorized.svg',
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_user_slug ON categories(COALESCE(user_id, 'global'), slug);

      CREATE TABLE IF NOT EXISTS accounts_or_payment_sources (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        payment_method TEXT NOT NULL,
        masked_identifier TEXT,
        institution TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ingestion_connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'paused',
        consent_granted INTEGER NOT NULL DEFAULT 0,
        consent_granted_at TEXT,
        scopes_json TEXT NOT NULL DEFAULT '[]',
        encrypted_secret TEXT,
        webhook_token_hash TEXT,
        last_sync_at TEXT,
        last_error TEXT,
        pending_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS import_batches (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        filename TEXT,
        total_rows INTEGER NOT NULL DEFAULT 0,
        imported_rows INTEGER NOT NULL DEFAULT 0,
        duplicate_rows INTEGER NOT NULL DEFAULT 0,
        review_rows INTEGER NOT NULL DEFAULT 0,
        failed_rows INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'completed',
        summary_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
        type TEXT NOT NULL CHECK (type IN ('expense', 'income', 'transfer', 'refund')),
        occurred_at TEXT NOT NULL,
        local_date TEXT NOT NULL,
        merchant TEXT NOT NULL,
        description TEXT DEFAULT '',
        category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
        subcategory TEXT DEFAULT '',
        payment_method TEXT NOT NULL DEFAULT 'PhonePe UPI',
        source_account_id TEXT REFERENCES accounts_or_payment_sources(id) ON DELETE SET NULL,
        reference_id TEXT,
        notes TEXT DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        receipt_path TEXT,
        import_source TEXT NOT NULL DEFAULT 'manual',
        import_timestamp TEXT,
        external_id TEXT,
        fingerprint TEXT,
        confidence TEXT NOT NULL DEFAULT 'high',
        reconciliation_status TEXT NOT NULL DEFAULT 'verified',
        duplicate_of_id TEXT,
        is_split INTEGER NOT NULL DEFAULT 0,
        is_demo INTEGER NOT NULL DEFAULT 0,
        batch_id TEXT REFERENCES import_batches(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, local_date DESC);
      CREATE INDEX IF NOT EXISTS idx_tx_user_cat ON transactions(user_id, category_id);
      CREATE INDEX IF NOT EXISTS idx_tx_user_fp ON transactions(user_id, fingerprint);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_idempotent_ext
        ON transactions(user_id, import_source, external_id)
        WHERE external_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS transaction_splits (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
        amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
        note TEXT DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS ingestion_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connection_id TEXT REFERENCES ingestion_connections(id) ON DELETE SET NULL,
        batch_id TEXT REFERENCES import_batches(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        external_id TEXT,
        raw_hash TEXT NOT NULL,
        payload_summary TEXT NOT NULL,
        parsed_json TEXT NOT NULL DEFAULT '{}',
        confidence TEXT NOT NULL DEFAULT 'medium',
        status TEXT NOT NULL DEFAULT 'needs_review',
        error_message TEXT,
        transaction_id TEXT REFERENCES transactions(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ing_events_user ON ingestion_events(user_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS merchant_category_rules (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        merchant_pattern TEXT NOT NULL,
        match_type TEXT NOT NULL DEFAULT 'contains',
        category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        payment_method TEXT,
        priority INTEGER NOT NULL DEFAULT 10,
        learned_from_correction INTEGER NOT NULL DEFAULT 0,
        hit_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS budgets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        month_key TEXT NOT NULL,
        overall_limit_paise INTEGER NOT NULL DEFAULT 0,
        alert_thresholds_json TEXT NOT NULL DEFAULT '[50,75,90,100]',
        rollover_enabled INTEGER NOT NULL DEFAULT 0,
        reset_day INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_budgets_user_month ON budgets(user_id, month_key);

      CREATE TABLE IF NOT EXISTS budget_categories (
        id TEXT PRIMARY KEY,
        budget_id TEXT NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        limit_paise INTEGER NOT NULL DEFAULT 0,
        rollover_paise INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_budget_cat_unique ON budget_categories(budget_id, category_id);

      CREATE TABLE IF NOT EXISTS savings_goals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        target_paise INTEGER NOT NULL CHECK (target_paise > 0),
        current_paise INTEGER NOT NULL DEFAULT 0,
        target_date TEXT,
        monthly_contribution_paise INTEGER NOT NULL DEFAULT 0,
        color TEXT NOT NULL DEFAULT '#10B981',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS recurring_rules (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        merchant TEXT NOT NULL,
        amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
        type TEXT NOT NULL DEFAULT 'expense',
        category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
        payment_method TEXT NOT NULL DEFAULT 'PhonePe UPI',
        cadence TEXT NOT NULL DEFAULT 'monthly',
        next_due_date TEXT NOT NULL,
        last_matched_date TEXT,
        auto_create INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daily_reports (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        report_date TEXT NOT NULL,
        timezone TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        summary_json TEXT NOT NULL DEFAULT '{}',
        html_preview TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS email_delivery_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        daily_report_id TEXT REFERENCES daily_reports(id) ON DELETE SET NULL,
        recipient_email TEXT NOT NULL,
        report_type TEXT NOT NULL DEFAULT 'daily_summary',
        idempotency_key TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'brevo',
        provider_message_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        http_status INTEGER,
        retry_count INTEGER NOT NULL DEFAULT 0,
        failure_reason TEXT,
        response_json TEXT DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT,
        ip_address TEXT,
        user_agent TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS password_resets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        created_at TEXT NOT NULL
      );
    `
  }
];

const PG_MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    sql: SQLITE_MIGRATIONS[0].sql
      .replace(/\bINTEGER\b(?=\s+NOT NULL\s+CHECK\s+\(amount_paise)/g, 'BIGINT')
      .replace(/limit_paise INTEGER/g, 'limit_paise BIGINT')
      .replace(/overall_limit_paise INTEGER/g, 'overall_limit_paise BIGINT')
      .replace(/target_paise INTEGER/g, 'target_paise BIGINT')
      .replace(/current_paise INTEGER/g, 'current_paise BIGINT')
      .replace(/monthly_contribution_paise INTEGER/g, 'monthly_contribution_paise BIGINT')
      .replace(/rollover_paise INTEGER/g, 'rollover_paise BIGINT')
  }
];

module.exports = { SQLITE_MIGRATIONS, PG_MIGRATIONS };
