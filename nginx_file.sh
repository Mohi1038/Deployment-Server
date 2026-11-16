#!/bin/bash

# Check if running with sudo privileges to write in /etc/nginx/conf.d/ 
# because it is protected and require root acces
if [ "$EUID" -ne 0 ]; then
  echo "Please run with sudo privileges to write to /etc/nginx/conf.d/"
  exit 1
fi

# Check if Nginx is installed
if ! command -v nginx &> /dev/null; then
    echo "Nginx is not installed. Please install Nginx first."
    exit 1
fi

# Check if /etc/nginx/conf.d/ exists, create it if not
if [ ! -d "/etc/nginx/conf.d" ]; then
    echo "/etc/nginx/conf.d/ directory does not exist. Creating it..."
    mkdir -p /etc/nginx/conf.d/
fi

# Check if enough arguments are passed
if [ "$#" -ne 8 ] && [ "$#" -ne 10 ]; then
    echo "Usage: $0 <file-name> <ip/domain> <frontend: yes/no> <frontend-route> <frontend-port> <backend: yes/no> <backend-route> <backend-port> <ssl-email> <ssl-enabled: yes/no>"
    exit 1
fi

# Assign input arguments
FILE_NAME=$1
DOMAIN=$2
FRONTEND_PRESENT=$3
FRONTEND_ROUTE=$4
FRONTEND_PORT=$5
BACKEND_PRESENT=$6
BACKEND_ROUTE=$7
BACKEND_PORT=$8
SSL_EMAIL=${9:-}
SSL_ENABLED=${10:-no}

CONF_PATH="/etc/nginx/conf.d/$FILE_NAME.conf"

# Validate that ports are numbers if they are present
# For frontend
if [ "$FRONTEND_PRESENT" == "yes" ] && ! [[ "$FRONTEND_PORT" =~ ^[0-9]+$ ]]; then
    echo "Error: Frontend port must be a numeric value."
    exit 1
fi

# For backend
if [ "$BACKEND_PRESENT" == "yes" ] && ! [[ "$BACKEND_PORT" =~ ^[0-9]+$ ]]; then
    echo "Error: Backend port must be a numeric value."
    exit 1
fi

# Write the Nginx configuration to the file
cat > "$CONF_PATH" <<EOF
server {
    listen 80;
    server_name $DOMAIN;
EOF

# Add frontend route if applicable
if [ "$FRONTEND_PRESENT" == "yes" ]; then
  cat >> "$CONF_PATH" <<EOF

    # Frontend configuration
    location $FRONTEND_ROUTE {
        proxy_pass http://localhost:$FRONTEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
EOF
fi

# Add backend route if applicable
if [ "$BACKEND_PRESENT" == "yes" ]; then
  cat >> "$CONF_PATH" <<EOF

    # Backend configuration
    location $BACKEND_ROUTE {
        proxy_pass http://localhost:$BACKEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }
EOF
fi

# Close server block
cat >> "$CONF_PATH" << 'EOF'
}
EOF

# Config test and reload
nginx -t || { echo "Error: Invalid Nginx configuration"; exit 1; }
systemctl reload nginx || { echo "Error: Nginx reload failed"; exit 1; }

if [ "$SSL_ENABLED" = "yes" ]; then
  if [ "$DOMAIN" = "_" ] || [ -z "$SSL_EMAIL" ]; then
    echo "Error: SSL requires a real domain and certificate email."
    exit 1
  fi
  apt-get install -y certbot python3-certbot-nginx
  certbot --nginx --non-interactive --agree-tos --email "$SSL_EMAIL" --redirect -d "$DOMAIN"
  systemctl enable certbot.timer
fi

echo "Success: Nginx configuration applied"
echo "Config: $CONF_PATH"