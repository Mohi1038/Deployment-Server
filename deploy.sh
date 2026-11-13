#!/usr/bin/bash

# Check if correct number of arguments are provided
if [ "$#" -lt 3 ] || [ "$#" -gt 4 ]; then
    echo "Usage: $0 <git-username> <repo-name> <repo-type> [PAT-token]"
    echo "repo-type: 'public' or 'private'"
    echo "PAT-token is required only for private repositories"
    exit 1
fi

GIT_USERNAME="$1"
REPO_NAME="$2"
REPO_TYPE="$3"
PAT_TOKEN="$4"

if [[ "$REPO_TYPE" != "public" && "$REPO_TYPE" != "private" ]]; then
    echo "Error: Repository type must be 'public' or 'private'"
    exit 1
fi

if [[ "$REPO_TYPE" == "private" && -z "$PAT_TOKEN" ]]; then
    echo "Error: PAT token is required for private repositories"
    exit 1
fi

check_status() {
    if [ $? -eq 0 ]; then
        echo "$1 successful"
    else
        echo "Error: $1 failed"
        exit 1
    fi
}

echo "Updating package list..."
sudo apt-get update -y
check_status "Package list update"

echo "Installing required packages..."
sudo apt-get install -y curl apt-transport-https ca-certificates software-properties-common git nginx jq
check_status "Required packages installation"

# Install Docker
if ! command -v docker &> /dev/null; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    sudo usermod -aG docker $USER
fi

# Install Docker Compose
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo "Installing Docker Compose..."
    sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
    sudo chmod +x /usr/local/bin/docker-compose
fi

# Create directory for the project
PROJECT_DIR="/opt/$REPO_NAME"
sudo mkdir -p $PROJECT_DIR
sudo chown $USER:$USER $PROJECT_DIR
cd $PROJECT_DIR

# Clone the repository
echo "Cloning repository..."
if [[ "$REPO_TYPE" == "private" ]]; then
    git clone https://oauth2:${PAT_TOKEN}@github.com/${GIT_USERNAME}/${REPO_NAME}.git .
else
    git clone https://github.com/${GIT_USERNAME}/${REPO_NAME}.git .
fi
check_status "Repository cloning"

# ========================================================
# UNIVERSAL APPLICATION LAUNCHER
# Supports: Docker Compose, Dockerfile, Node.js, Python, Static HTML
# ========================================================
echo "Analyzing repository stack..."

# 1. Docker Compose
COMPOSE_FILE=$(find . -maxdepth 2 -name "docker-compose.yml" -o -name "docker-compose.yaml" | head -n 1)
if [ -n "$COMPOSE_FILE" ]; then
    echo "Found Docker Compose at $COMPOSE_FILE. Starting..."
    cd "$(dirname "$COMPOSE_FILE")"
    docker compose up -d --build 2>/dev/null || docker-compose up -d --build
    echo "Docker Compose services launched."
    exit 0
fi

# 2. Dockerfile
DOCKER_FILE=$(find . -maxdepth 2 -name "Dockerfile" | head -n 1)
if [ -n "$DOCKER_FILE" ]; then
    DOCKER_DIR="$(dirname "$DOCKER_FILE")"
    echo "Found Dockerfile in $DOCKER_DIR. Building container..."
    cd "$DOCKER_DIR"
    EXPOSED_PORT=$(grep -iE "^EXPOSE[[:space:]]+[0-9]+" Dockerfile | head -n 1 | awk '{print $2}' | tr -d '\r')
    TARGET_PORT=${EXPOSED_PORT:-3000}
    docker build -t "${REPO_NAME}:latest" .
    docker run -d --name "${REPO_NAME}-app" --restart unless-stopped -p 3000:${TARGET_PORT} "${REPO_NAME}:latest"
    echo "Docker container launched on port 3000."
    exit 0
fi

# 3. Node.js
PACKAGE_FILE=$(find . -maxdepth 2 -name "package.json" | head -n 1)
if [ -n "$PACKAGE_FILE" ]; then
    NODE_DIR="$(dirname "$PACKAGE_FILE")"
    echo "Found Node.js project in $NODE_DIR."
    cd "$NODE_DIR"
    if ! command -v node &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
        sudo apt-get install -y nodejs
    fi
    npm install
    PORT=3000 nohup npm start > /var/log/app.log 2>&1 &
    echo "Node.js application started on port 3000."
    exit 0
fi

# 4. Python
REQ_FILE=$(find . -maxdepth 2 -name "requirements.txt" | head -n 1)
if [ -n "$REQ_FILE" ] || [ -f "app.py" ] || [ -f "main.py" ] || [ -f "manage.py" ]; then
    echo "Found Python application."
    sudo apt-get install -y python3 python3-pip python3-venv
    python3 -m venv venv
    source venv/bin/activate
    [ -f "requirements.txt" ] && pip install -r requirements.txt
    if [ -f "app.py" ]; then
        PORT=3000 nohup python3 app.py > /var/log/app.log 2>&1 &
    elif [ -f "main.py" ]; then
        pip install uvicorn
        nohup uvicorn main:app --host 0.0.0.0 --port 3000 > /var/log/app.log 2>&1 &
    fi
    echo "Python application started on port 3000."
    exit 0
fi

echo "Installation and automated universal deployment completed!"
