-- ============================================================
-- JPL Library Security Monitor — SQL Setup Script
-- Run on the Read Replica server: 137.184.15.52
-- ============================================================

-- 1. Verify replication is running on the replica
SHOW SLAVE STATUS\G;

-- 2. Create the security monitoring database (if not using koha DB directly)
CREATE DATABASE IF NOT EXISTS jpl_security_monitor
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE jpl_security_monitor;

-- 3. Book Whitelist Table
--    Tracks ISBNs/barcodes that are APPROVED for circulation.
--    Any issue involving a barcode NOT in this table triggers an alert.
CREATE TABLE IF NOT EXISTS book_whitelist (
    id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    barcode       VARCHAR(50)  NOT NULL UNIQUE COMMENT 'Item barcode from Koha items table',
    isbn          VARCHAR(20)  NULL       COMMENT 'Optional ISBN for reference',
    title         VARCHAR(512) NOT NULL   COMMENT 'Book title for human-readable UI',
    author        VARCHAR(256) NULL,
    added_by      VARCHAR(100) NOT NULL DEFAULT 'admin',
    reason        TEXT         NULL       COMMENT 'Why this book is whitelisted',
    is_active     TINYINT(1)   NOT NULL DEFAULT 1,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_barcode   (barcode),
    INDEX idx_isbn      (isbn),
    INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Security whitelist of approved circulating books';

-- 4. Security Alert Log Table
--    Persistent log of every triggered alert
CREATE TABLE IF NOT EXISTS security_alerts (
    id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    alert_type      ENUM('UNAUTHORIZED_ISSUE','UNAUTHORIZED_RETURN','ITEM_NOT_FOUND') NOT NULL,
    issue_id        INT UNSIGNED NULL   COMMENT 'Koha issues.issue_id',
    barcode         VARCHAR(50)  NOT NULL,
    borrower_number INT UNSIGNED NULL,
    borrower_name   VARCHAR(256) NULL,
    branch_code     VARCHAR(10)  NULL,
    detected_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    acknowledged    TINYINT(1)   NOT NULL DEFAULT 0,
    acknowledged_by VARCHAR(100) NULL,
    acknowledged_at DATETIME     NULL,
    raw_event       JSON         NULL    COMMENT 'Full CDC event payload for forensics',
    INDEX idx_detected_at  (detected_at),
    INDEX idx_barcode      (barcode),
    INDEX idx_acknowledged (acknowledged)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Log of all security alerts';

-- 5. Monitoring User (read-only on Koha tables, full access on security DB)
--    Run this on the PRIMARY (production) server so it replicates across.
CREATE USER IF NOT EXISTS 'sec_monitor'@'%' IDENTIFIED BY 'SecMon@JPL2025!';
GRANT SELECT, REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'sec_monitor'@'%';
GRANT ALL PRIVILEGES ON jpl_security_monitor.* TO 'sec_monitor'@'%';
FLUSH PRIVILEGES;

-- 6. Enable binary logging variables needed for CDC (set in my.cnf on PRIMARY)
--    These are shown here for documentation; apply them in /etc/mysql/my.cnf
-- [mysqld]
-- server-id          = 1
-- log_bin            = /var/log/mysql/mysql-bin.log
-- binlog_format      = ROW          <-- REQUIRED for python-mysql-replication
-- binlog_row_image   = FULL         <-- REQUIRED for full before/after images
-- expire_logs_days   = 7
-- max_binlog_size    = 100M

-- Verify binary log format (run on primary):
-- SHOW VARIABLES LIKE 'binlog_format';   -- must return ROW
-- SHOW VARIABLES LIKE 'log_bin';         -- must return ON
