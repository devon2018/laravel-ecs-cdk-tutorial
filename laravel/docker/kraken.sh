#!/bin/sh

cd /var/www

php artisan migrate --force
php artisan optimize
php artisan config:cache
php artisan route:cache

/usr/bin/supervisord -c /etc/supervisord.conf

