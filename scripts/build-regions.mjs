import { readFile, writeFile } from "node:fs/promises";

const selected = new Map([
  ["UA-05", ["vinnytsia", "Винницкая"]], ["UA-07", ["volyn", "Волынская"]],
  ["UA-12", ["dnipropetrovsk", "Днепропетровская"]], ["UA-18", ["zhytomyr", "Житомирская"]],
  ["UA-21", ["zakarpattia", "Закарпатская"]], ["UA-23", ["zaporizhzhia", "Запорожская"]],
  ["UA-26", ["ivano-frankivsk", "Ивано-Франковская"]], ["UA-32", ["kyiv", "Киевская"]],
  ["UA-30", ["kyiv", "Киевская"]], ["UA-35", ["kirovohrad", "Кировоградская"]],
  ["UA-46", ["lviv", "Львовская"]], ["UA-48", ["mykolaiv", "Николаевская"]],
  ["UA-51", ["odesa", "Одесская"]], ["UA-53", ["poltava", "Полтавская"]],
  ["UA-56", ["rivne", "Ровненская"]], ["UA-59", ["sumy", "Сумская"]],
  ["UA-61", ["ternopil", "Тернопольская"]], ["UA-63", ["kharkiv", "Харьковская"]],
  ["UA-65", ["kherson", "Херсонская"]], ["UA-68", ["khmelnytskyi", "Хмельницкая"]],
  ["UA-71", ["cherkasy", "Черкасская"]], ["UA-74", ["chernihiv", "Черниговская"]],
  ["UA-77", ["chernivtsi", "Черновицкая"]],
]);

const source = JSON.parse(await readFile(new URL("../data/regions-source.geojson", import.meta.url), "utf8"));
const features = source.features
  .filter((feature) => selected.has(feature.properties.shapeISO))
  .map((feature) => {
    const [regionId, nameRu] = selected.get(feature.properties.shapeISO);
    return {
      ...feature,
      properties: { id: regionId, name: nameRu, iso: feature.properties.shapeISO, sourceName: feature.properties.shapeName },
    };
  });

await writeFile(new URL("../data/regions.geojson", import.meta.url), `${JSON.stringify({ type: "FeatureCollection", features })}\n`);
console.log(`Prepared ${features.length} boundary features for ${new Set(features.map((item) => item.properties.id)).size} region filters.`);
