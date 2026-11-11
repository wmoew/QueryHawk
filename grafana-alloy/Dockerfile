FROM grafana/alloy:latest

# Copy configuration files
COPY config.river /etc/alloy/config.river
COPY targets/ /etc/alloy/targets/

# Create targets directory
RUN mkdir -p /etc/alloy/targets

# Set working directory
WORKDIR /etc/alloy

# Expose ports
EXPOSE 12345 12346 14317 14318

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:12345/ready || exit 1

# Start Alloy with the correct syntax for newer versions
# Listen on all interfaces so the UI on :12345 is reachable from the host
CMD ["run", "--server.http.listen-addr=0.0.0.0:12345", "/etc/alloy/config.river"]
