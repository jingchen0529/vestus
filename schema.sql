-- Vestus initial MySQL schema. The application can also create these tables
-- automatically on startup; this file is useful for controlled deployments.
CREATE DATABASE IF NOT EXISTS `vestus` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `vestus`;

CREATE TABLE IF NOT EXISTS `admin` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(64) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `role` VARCHAR(32) NOT NULL DEFAULT 'admin',
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `token_version` INT UNSIGNED NOT NULL DEFAULT 1,
  `last_login_at` DATETIME(6) NULL,
  `last_login_ip` VARBINARY(16) NULL,
  `password_changed_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL,
  `updated_at` DATETIME(6) NOT NULL,
  `deleted_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_admin_username` (`username`), KEY `idx_admin_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `user` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `username` VARCHAR(64) NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL,
  `name` VARCHAR(100) NOT NULL,
  `company` VARCHAR(200) NULL,
  `phone` VARCHAR(32) NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `expires_at` DATETIME(6) NULL,
  `max_sessions` SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  `token_version` INT UNSIGNED NOT NULL DEFAULT 1,
  `failed_login_count` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `locked_until` DATETIME(6) NULL,
  `must_change_password` TINYINT(1) NOT NULL DEFAULT 0,
  `last_login_at` DATETIME(6) NULL,
  `last_login_ip` VARBINARY(16) NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `remark` VARCHAR(500) NULL,
  `created_at` DATETIME(6) NOT NULL,
  `updated_at` DATETIME(6) NOT NULL,
  `deleted_at` DATETIME(6) NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_user_username` (`username`), KEY `idx_user_status_expiry` (`status`,`expires_at`), KEY `idx_user_created` (`created_at`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `proxy` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL,
  `host` VARCHAR(255) NOT NULL,
  `port` INT NOT NULL,
  `username` VARCHAR(255) NOT NULL,
  `encrypted_password` BLOB NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `created_at` DATETIME(6) NOT NULL,
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_proxy_name` (`name`), KEY `idx_proxy_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `platform` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(100) NOT NULL,
  `url` VARCHAR(2048) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `created_at` DATETIME(6) NOT NULL,
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_platform_name` (`name`),
  KEY `idx_platform_status` (`status`), KEY `idx_platform_sort_order` (`sort_order`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `user_proxy_assignment` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `proxy_id` BIGINT NOT NULL,
  `created_at` DATETIME(6) NOT NULL,
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_user_proxy_assignment_user` (`user_id`),
  KEY `idx_user_proxy_assignment_proxy` (`proxy_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `user_platform_assignment` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT NOT NULL,
  `platform_id` BIGINT NOT NULL,
  `created_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`), UNIQUE KEY `uq_user_platform_assignment` (`user_id`,`platform_id`),
  KEY `idx_user_platform_assignment_platform` (`platform_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `user_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `request_id` CHAR(36) NULL,
  `actor_type` VARCHAR(16) NOT NULL,
  `actor_id` BIGINT UNSIGNED NULL,
  `actor_username` VARCHAR(64) NULL,
  `actor_role` VARCHAR(32) NULL,
  `action` VARCHAR(64) NOT NULL,
  `target_type` VARCHAR(16) NULL,
  `target_id` BIGINT UNSIGNED NULL,
  `target_name` VARCHAR(100) NULL,
  `summary` VARCHAR(500) NOT NULL,
  `ip_address` VARBINARY(16) NULL,
  `user_agent` VARCHAR(512) NULL,
  `status` VARCHAR(16) NOT NULL,
  `details` JSON NULL,
  `created_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`), KEY `idx_log_created` (`created_at`,`id`), KEY `idx_log_actor` (`actor_type`,`actor_id`,`created_at`), KEY `idx_log_action` (`action`,`created_at`), KEY `idx_log_status` (`status`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
