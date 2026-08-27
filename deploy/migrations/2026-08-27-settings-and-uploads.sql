-- Upgrade a database created before the settings, bypass-host and upload work.
-- Safe to run more than once on MySQL 8. Run this with a database account that
-- may ALTER and CREATE tables, before starting the new application version.

SET @vestus_migration_sql = IF(
  EXISTS(
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'platform'
      AND COLUMN_NAME = 'icon_url'
  ),
  'SELECT 1',
  'ALTER TABLE `platform` ADD COLUMN `icon_url` TEXT NULL AFTER `url`'
);
PREPARE vestus_migration_statement FROM @vestus_migration_sql;
EXECUTE vestus_migration_statement;
DEALLOCATE PREPARE vestus_migration_statement;

SET @vestus_migration_sql = IF(
  EXISTS(
    SELECT 1
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'proxy'
      AND COLUMN_NAME = 'bypass_hosts'
  ),
  'SELECT 1',
  'ALTER TABLE `proxy` ADD COLUMN `bypass_hosts` JSON NULL AFTER `encrypted_password`'
);
PREPARE vestus_migration_statement FROM @vestus_migration_sql;
EXECUTE vestus_migration_statement;
DEALLOCATE PREPARE vestus_migration_statement;

CREATE TABLE IF NOT EXISTS `system_setting` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `key` VARCHAR(64) NOT NULL,
  `value` TEXT NOT NULL,
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_system_setting_key` (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `uploaded_file` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `original_name` VARCHAR(255) NOT NULL,
  `path` VARCHAR(512) NOT NULL,
  `content_type` VARCHAR(255) NOT NULL,
  `size` BIGINT NOT NULL,
  `uploaded_by` BIGINT NOT NULL,
  `created_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_uploaded_file_path` (`path`),
  KEY `idx_uploaded_file_uploaded_by` (`uploaded_by`),
  KEY `idx_uploaded_file_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
