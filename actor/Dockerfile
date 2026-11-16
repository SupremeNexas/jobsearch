# Use the official Apify image with Playwright pre-installed
FROM apify/actor-node-playwright-chrome:18

# Copy package config with correct permissions
COPY --chown=myuser:myuser package*.json ./

# Install packages
RUN npm install --only=prod --no-audit

# Copy sources with correct permissions
COPY --chown=myuser:myuser . ./

# Run the actor
CMD [ "npm", "start" ]
