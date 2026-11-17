/**
 * Devlups Lab — 1-Click Database Add-ons & Live Metrics Service
 * Supports PostgreSQL, Redis, MySQL, MongoDB, and Telemetry
 */

import crypto from 'crypto';

export const addonService = {
  /**
   * Generate bash commands to provision database container with persistent storage
   */
  generateDatabaseScript(addon = 'none', repoName = 'app') {
    if (!addon || addon === 'none') return '';

    const safeName = repoName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const randomPassword = crypto.randomBytes(8).toString('hex');

    if (addon === 'postgres' || addon === 'postgresql') {
      return `
# =========================================================
# 1-CLICK ADDON: PostgreSQL Database Engine
# =========================================================
echo "[Addon Engine] Provisioning PostgreSQL 15 container..."
docker run -d \\
  --name "db-postgres-${safeName}" \\
  --restart unless-stopped \\
  -e POSTGRES_DB="${safeName}" \\
  -e POSTGRES_USER="postgres" \\
  -e POSTGRES_PASSWORD="${randomPassword}" \\
  -v "postgres_${safeName}_data:/var/lib/postgresql/data" \\
  -p 5432:5432 \\
  postgres:15-alpine

export DATABASE_URL="postgresql://postgres:${randomPassword}@localhost:5432/${safeName}"
echo "DATABASE_URL=postgresql://postgres:${randomPassword}@localhost:5432/${safeName}" >> /opt/${repoName}/.env
echo "[Addon Engine] PostgreSQL active. Injected DATABASE_URL into .env"
`;
    }

    if (addon === 'redis') {
      return `
# =========================================================
# 1-CLICK ADDON: Redis In-Memory Cache & Queue
# =========================================================
echo "[Addon Engine] Provisioning Redis 7 container..."
docker run -d \\
  --name "cache-redis-${safeName}" \\
  --restart unless-stopped \\
  -v "redis_${safeName}_data:/data" \\
  -p 6379:6379 \\
  redis:7-alpine

export REDIS_URL="redis://localhost:6379"
echo "REDIS_URL=redis://localhost:6379" >> /opt/${repoName}/.env
echo "[Addon Engine] Redis active. Injected REDIS_URL into .env"
`;
    }

    if (addon === 'mysql') {
      return `
# =========================================================
# 1-CLICK ADDON: MySQL 8 Database
# =========================================================
echo "[Addon Engine] Provisioning MySQL 8 container..."
docker run -d \\
  --name "db-mysql-${safeName}" \\
  --restart unless-stopped \\
  -e MYSQL_ROOT_PASSWORD="${randomPassword}" \\
  -e MYSQL_DATABASE="${safeName}" \\
  -v "mysql_${safeName}_data:/var/lib/mysql" \\
  -p 3306:3306 \\
  mysql:8-oracle

export DATABASE_URL="mysql://root:${randomPassword}@localhost:3306/${safeName}"
echo "DATABASE_URL=mysql://root:${randomPassword}@localhost:3306/${safeName}" >> /opt/${repoName}/.env
echo "[Addon Engine] MySQL active. Injected DATABASE_URL into .env"
`;
    }

    if (addon === 'mongo' || addon === 'mongodb') {
      return `
# =========================================================
# 1-CLICK ADDON: MongoDB 6 NoSQL Database
# =========================================================
echo "[Addon Engine] Provisioning MongoDB container..."
docker run -d \\
  --name "db-mongo-${safeName}" \\
  --restart unless-stopped \\
  -v "mongo_${safeName}_data:/data/db" \\
  -p 27017:27017 \\
  mongo:6

export MONGO_URL="mongodb://localhost:27017/${safeName}"
echo "MONGO_URL=mongodb://localhost:27017/${safeName}" >> /opt/${repoName}/.env
echo "[Addon Engine] MongoDB active. Injected MONGO_URL into .env"
`;
    }

    return '';
  },

  /**
   * Generate bash commands to safely write decrypted .env on the server
   */
  generateEnvScript(envVarsString, repoName) {
    if (!envVarsString) return `touch /opt/${repoName}/.env\n`;

    const cleaned = envVarsString.trim();
    if (!cleaned) return `touch /opt/${repoName}/.env\n`;

    return `
# =========================================================
# ENVIRONMENT VARIABLES INJECTION (.env)
# =========================================================
echo "[Security] Injecting encrypted environment variables into .env..."
cat > "/opt/${repoName}/.env" << 'ENV_EOF'
${cleaned}
ENV_EOF
chmod 600 "/opt/${repoName}/.env"
`;
  }
};
