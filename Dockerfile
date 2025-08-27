# Simple static site served by Nginx
FROM nginx:1.27-alpine

# Copy site content
COPY index.html /usr/share/nginx/html/index.html
COPY style.css /usr/share/nginx/html/style.css
COPY script.js /usr/share/nginx/html/script.js

# Provide a basic health check (optional)
HEALTHCHECK CMD wget -q -O /dev/null http://localhost:80 || exit 1

# Nginx already exposes port 80
