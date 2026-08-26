# Static site + OneDrive upload relay
FROM node:20-alpine

WORKDIR /app

# No dependencies: server.js uses only the Node standard library
COPY server.js ./
COPY index.html style.css custom.css script.js ./public/
COPY assets/ ./public/assets/

ENV PORT=80
# The container must accept traffic from CapRover's proxy, not just loopback
ENV HOST=0.0.0.0
EXPOSE 80

HEALTHCHECK CMD wget -q -O /dev/null http://localhost:80/ || exit 1

CMD ["node", "server.js"]
