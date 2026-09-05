# Static site + guest photo upload, saved to the /data volume
FROM node:20-alpine

WORKDIR /app

# No dependencies: server.js uses only the Node standard library
COPY server.js ./
COPY index.html style.css custom.css script.js ./public/
COPY assets/ ./public/assets/

ENV PORT=80
# The container must accept traffic from CapRover's proxy, not just loopback
ENV HOST=0.0.0.0
# Nothing reaches this container except through that proxy, so its
# X-Forwarded-For is the only way to tell one guest from another
ENV TRUST_PROXY=1
EXPOSE 80

HEALTHCHECK CMD wget -q -O /dev/null http://localhost:80/health || exit 1

CMD ["node", "server.js"]
