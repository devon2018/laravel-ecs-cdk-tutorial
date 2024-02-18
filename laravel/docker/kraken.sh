#!/bin/sh

cd /var/www

php artisan migrate --force
php artisan optimize
php artisan config:cache
# php artisan storage:link
php artisan route:cache
php artisan generate:sitemap
php artisan generate:seo-crawler-sitemap

/usr/bin/supervisord -c /etc/supervisord.conf

