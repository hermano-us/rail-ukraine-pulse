INSERT OR IGNORE INTO fuel_sources(
  source_id,name,source_type,base_url,reliability,usage_permission,enabled,created_at,updated_at
) VALUES(
  'carta-ua','Carta.ua','partner_catalog','https://carta.ua',0.88,'partner_feed',1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
