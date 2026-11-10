# VMS deployment on the shared DOK server - vms.testsys.shop

Server: application-docker-server, IP 34.93.171.14. Stack folder: ~/vms-stack. Containers: vms-db, vms-redis, vms-api, vms-web.
Every command below is plain ASCII, one per line, so it can be pasted into a terminal.
Run docker compose commands from ~/vms-stack (the folder that holds docker-compose.prod.yml and .env).

## 0. Before you start

DNS: the A record for vms.testsys.shop must point to 34.93.171.14.

```
nslookup vms.testsys.shop
```

Capacity: this stack is capped at 3 CPU and about 3.8 GB RAM in total (db 1 / 2G, api 1 / 1G, web 0.5 / 512M, redis 0.5 / 256M).

```
docker stats --no-stream
```

## 1. Data folders on the data disk

Confirm the disk is mounted and persists across reboots.

```
findmnt /mnt/disks/data
grep disks/data /etc/fstab
```

Create the folders. Postgres (alpine) runs as uid 70, Redis (alpine) as uid 999 with gid 1000. Never use chmod 777.

```
sudo mkdir -p /mnt/disks/data/db/vms /mnt/disks/data/db/vms-redis /mnt/disks/data/backups/vms
sudo chown -R 70:70 /mnt/disks/data/db/vms
sudo chown -R 999:1000 /mnt/disks/data/db/vms-redis
sudo chown -R $USER:$USER /mnt/disks/data/backups/vms
chmod 700 /mnt/disks/data/backups/vms
df -h /mnt/disks/data
```

## 2. Get the code and create .env

```
git clone <repo-url> ~/vms-stack
cd ~/vms-stack
```

Create a fresh .env (do not copy the developer values). Passwords are hex so they are safe inside connection URLs.

```
umask 077
: > .env
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)" >> .env
echo "REDIS_PASSWORD=$(openssl rand -hex 24)" >> .env
echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')" >> .env
echo "DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
echo "NIC_HASH_KEY=$(openssl rand -hex 32)" >> .env
echo "VMS_DOMAIN=vms.testsys.shop" >> .env
echo "DATA_ROOT=/mnt/disks/data" >> .env
chmod 600 .env
```

IMPORTANT: copy DATA_ENCRYPTION_KEY and NIC_HASH_KEY into the DOK password store now. If DATA_ENCRYPTION_KEY is lost, every stored NIC is unreadable. If NIC_HASH_KEY changes, NIC search and the watch list stop working.

Optional (when the client provides them): add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, SMTP_FROM to .env. Until then SMS and e-mail are only logged.

## 3. Build and first start

```
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d vms-db vms-redis
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml run --rm vms-api npx prisma migrate deploy
```

Create the first super administrator and the master data (first deploy only). Choose a strong password (12+ characters).

```
export SEED_ADMIN_USERNAME=admin
read -s -p "Admin password: " SEED_ADMIN_PASSWORD; export SEED_ADMIN_PASSWORD; echo
docker compose -f docker-compose.prod.yml run --rm -e SEED_ADMIN_USERNAME -e SEED_ADMIN_PASSWORD vms-api node dist-seed/seed.js
unset SEED_ADMIN_PASSWORD
```

The seed creates departments HR, IT, Security, the five pass categories and three PLACEHOLDER guard rooms. Rename the guard rooms in the admin portal once the client supplies the real names. Do NOT run seed:demo on the server.

```
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=50 vms-api
docker stats --no-stream
```

All four containers must show healthy.

## 4. SSL certificate (single host, no wildcard)

DNS challenge (add the TXT record, verify it on 8.8.8.8, 1.1.1.1 and 9.9.9.9, wait about 10 minutes, then press Enter):

```
docker run --rm -it -v ~/dok-stack/certbot/conf:/etc/letsencrypt -v ~/dok-stack/certbot/www:/var/www/certbot certbot/certbot certonly --manual --preferred-challenges dns --email wasath@doksolutions.lk --agree-tos --no-eff-email -d vms.testsys.shop
```

If the DNS for testsys.shop is managed by another team, add only the port 80 server block from ops/nginx-vms.conf first, reload nginx, and use the HTTP challenge instead:

```
docker run --rm -v ~/dok-stack/certbot/conf:/etc/letsencrypt -v ~/dok-stack/certbot/www:/var/www/certbot certbot/certbot certonly --webroot -w /var/www/certbot --email wasath@doksolutions.lk --agree-tos --no-eff-email -d vms.testsys.shop
```

Check the real folder name under live/ before the nginx file references it. Let's Encrypt certificates expire in 90 days: set a calendar reminder.

```
ls ~/dok-stack/certbot/conf/live/
```

## 5. Nginx

Append both server blocks from ops/nginx-vms.conf to ~/dok-stack/nginx/nginx.conf (before the default catch-all). Then test and reload.

```
cd ~/dok-stack
docker compose exec nginx nginx -t
docker compose exec nginx nginx -s reload
```

If you see 502 after recreating a container, nginx holds a stale address: reload it again.

## 6. Check it works

```
curl -I https://vms.testsys.shop
curl -s https://vms.testsys.shop/api/health
```

Expected: HTTP 200 for the site and {"status":"ok"} for the health check. Then in a browser: padlock, sign in as the admin, create a guard and a host, pre-register a visitor, check in from the guard console, and confirm the live alert appears on the guard screen (this proves the /ws WebSocket path through nginx).

## 7. Backups (daily, 30 days kept)

```
cd ~/vms-stack
chmod +x ops/backup.sh
./ops/backup.sh
ls -lh /mnt/disks/data/backups/vms
crontab -e
```

Add this line to the crontab:

```
15 2 * * * cd ~/vms-stack && ./ops/backup.sh >> ~/vms-stack/backup.log 2>&1
```

Do one restore drill into a scratch database before go-live (never into the live one). Add a monitor for https://vms.testsys.shop/api/health in Uptime Kuma.

## 8. Updating after a push to main

```
cd ~/vms-stack
git status
git pull origin main
git log -1 --oneline
docker compose -f docker-compose.prod.yml up -d --build vms-api vms-web
docker compose -f docker-compose.prod.yml run --rm vms-api npx prisma migrate deploy
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=50 vms-api
cd ~/dok-stack
docker compose exec nginx nginx -s reload
```

.env is not in git, so a pull never touches it. Occasionally run docker image prune -f to protect the boot disk.

## Known limits

- Anything on the shared-nginx network can reach vms-api and vms-web directly. Only nginx should be attached to it.
- The database dumps contain personal data in plain text (phone numbers, addresses). Keep ~/vms-stack/ops/backup.sh output on the data disk only, copy off-server encrypted, and restrict access.
