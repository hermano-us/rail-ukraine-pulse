-- Operational border anchors. Values are normalized station identifiers used by
-- rail_nodes; common Ukrainian and transliterated aliases are retained because
-- upstream public sources do not use one canonical alphabet consistently.
UPDATE international_corridors SET border_nodes_json='["мостиська-2","мостиска-2","mostyska-2","ягодин","yahodyn","ізов","изов","izov","рава-руська","рава-русская","rava-ruska"]' WHERE corridor_id='ua-pl';

UPDATE international_corridors SET border_nodes_json='["чоп","chop","ужгород","uzhhorod"]' WHERE corridor_id='ua-sk';

UPDATE international_corridors SET border_nodes_json='["чоп","chop","батево","batovo","королево","korolevo"]' WHERE corridor_id='ua-hu';

UPDATE international_corridors SET border_nodes_json='["вадул-сірет","вадул-сирет","vadul-siret","ділове","деловое","dilove"]' WHERE corridor_id='ua-ro';

UPDATE international_corridors SET border_nodes_json='["кучурган","kuchurhan","могилів-подільський","могилев-подольский","mohyliv-podilskyi","сокиряни","sokyriany"]' WHERE corridor_id='ua-md';
