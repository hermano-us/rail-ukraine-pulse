import { writeFile } from "node:fs/promises";

const base = new Date("2026-07-17T09:00:00Z");
const at = (minutes) => new Date(base.getTime() + minutes * 60_000).toISOString();
const station = (id, label, minutes, coordinates, eventStatus = "scheduled", delayMinutes = 0) => ({
  id, label, plannedAt: at(minutes), delayMinutes, eventStatus, coordinates,
});

const places = {
  uzhhorod: [22.2878, 48.6208], mukachevo: [22.7181, 48.4412], lviv: [23.9948, 49.8390],
  ternopil: [25.5984, 49.5533], khmelnytskyi: [26.9966, 49.4216], vinnytsia: [28.4682, 49.2332],
  koziatyn: [28.8478, 49.7144], zhytomyr: [28.6632, 50.2636], fastiv: [29.9140, 50.0774],
  kyiv: [30.4840, 50.4406], nizhyn: [31.8914, 51.0478], chernihiv: [31.2794, 51.4982],
  sumy: [34.7982, 50.9102], poltava: [34.5320, 49.5990], kharkiv: [36.2607, 49.9897],
  dnipro: [35.0153, 48.4740], zaporizhzhia: [35.1904, 47.8239], kryvyiRih: [33.2050, 47.9104],
  kropyvnytskyi: [32.2676, 48.5079], cherksy: [32.0598, 49.4444], odesa: [30.7107, 46.4673],
  mykolaiv: [31.9944, 46.9755], kherson: [32.6081, 46.6487], rivne: [26.2516, 50.6199],
  lutsk: [25.3227, 50.7472], ivano: [24.7105, 48.9221], chernivtsi: [25.9413, 48.2914],
};

const routes = [
  ["corridor-lviv-dnipro", "Львов — Днепр", [places.lviv,[24.75,49.70],places.ternopil,[26.25,49.50],places.khmelnytskyi,[27.75,49.32],places.vinnytsia,places.koziatyn,places.fastiv,places.kyiv,[31.35,50.15],[32.30,49.82],places.poltava,[35.00,49.15],places.dnipro]],
  ["corridor-odesa-lviv", "Одесса — Львов", [places.odesa,[29.72,47.20],places.vinnytsia,[27.30,49.48],places.khmelnytskyi,places.ternopil,places.lviv]],
  ["corridor-kharkiv-ivano", "Харьков — Ивано-Франковск", [places.kharkiv,places.poltava,[32.40,49.78],places.kyiv,places.koziatyn,places.vinnytsia,places.khmelnytskyi,places.ternopil,[24.95,49.20],places.ivano]],
  ["corridor-kharkiv-uzhhorod", "Харьков — Ужгород", [places.kharkiv,places.poltava,places.kyiv,places.koziatyn,places.vinnytsia,places.khmelnytskyi,places.ternopil,places.lviv,[23.50,49.30],places.mukachevo,places.uzhhorod]],
  ["corridor-kyiv-lviv", "Киев — Львов", [places.kyiv,places.fastiv,places.koziatyn,places.vinnytsia,places.khmelnytskyi,places.ternopil,places.lviv]],
  ["corridor-kyiv-odesa", "Киев — Одесса", [places.kyiv,places.fastiv,[29.25,49.20],places.kropyvnytskyi,[31.10,47.75],places.odesa]],
  ["corridor-kyiv-chernivtsi", "Киев — Черновцы", [places.kyiv,places.fastiv,places.koziatyn,places.vinnytsia,places.khmelnytskyi,[26.20,48.85],places.chernivtsi]],
  ["corridor-sumy-kyiv", "Сумы — Киев", [places.sumy,[33.90,50.75],[32.65,50.60],places.nizhyn,places.kyiv]],
  ["corridor-dnipro-zaporizhzhia", "Днепр — Запорожье", [places.dnipro,[35.12,48.20],[35.16,48.00],places.zaporizhzhia]],
  ["corridor-kyiv-chernihiv", "Киев — Чернигов", [places.kyiv,[30.73,50.60],[31.05,50.85],places.nizhyn,[31.55,51.27],places.chernihiv]],
  ["corridor-lviv-lutsk", "Львов — Луцк — Ровно", [places.lviv,[24.20,50.20],places.lutsk,[25.70,50.70],places.rivne]],
  ["corridor-kyiv-kherson", "Киев — Херсон", [places.kyiv,places.cherksy,places.kropyvnytskyi,places.mykolaiv,places.kherson]],
];

const routeFeatures = routes.map(([id, name, coordinates]) => ({
  type: "Feature", properties: { id, name, quality: 0.72, geometryNote: "Упрощённая геометрия публичного пассажирского коридора" },
  geometry: { type: "LineString", coordinates },
}));

const photos = {
  hrcs2: { src: "assets/trains/hrcs2.jpg", fallback: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/%D0%A1%D0%BA%D0%BE%D1%80%D0%BE%D1%81%D1%82%D0%BD%D0%BE%D0%B9_%D0%BF%D0%BE%D0%B5%D0%B7%D0%B4_%22%D0%A5%D0%B5%D0%BD%D0%B4%D0%B0%D0%B9%22.jpg/1280px-%D0%A1%D0%BA%D0%BE%D1%80%D0%BE%D1%81%D1%82%D0%BD%D0%BE%D0%B9_%D0%BF%D0%BE%D0%B5%D0%B7%D0%B4_%22%D0%A5%D0%B5%D0%BD%D0%B4%D0%B0%D0%B9%22.jpg", alt: "Электропоезд HRCS2 Укрзалізниці", credit: "Николай Чуваев", license: "CC BY-SA 3.0", sourceUrl: "https://commons.wikimedia.org/wiki/File:Скоростной_поезд_\"Хендай\".jpg", representative: true },
  chs7: { src: "assets/trains/chs7.jpg", fallback: "https://upload.wikimedia.org/wikipedia/commons/6/69/ChS7-186_UZ_with_passenger_train.jpg", alt: "Электровоз ЧС7 с пассажирским поездом", credit: "Aivan1ch", license: "CC0 1.0", sourceUrl: "https://commons.wikimedia.org/wiki/File:ChS7-186_UZ_with_passenger_train.jpg", representative: true },
  epl9t: { src: "assets/trains/epl9t.jpg", fallback: "https://upload.wikimedia.org/wikipedia/commons/2/24/EPL9T-015.jpg", alt: "Пригородный электропоезд ЭПЛ9Т", credit: "Сергей Болашенко", license: "CC BY-SA 3.0", sourceUrl: "https://commons.wikimedia.org/wiki/File:EPL9T-015.jpg", representative: true },
};

const estimated = (lastConfirmedAt = at(-20)) => ({ status: "estimated", lastConfirmedAt });
const reported = (coordinates, updatedAt, method, confidence = 0.68) => ({ status: "reported", coordinates, updatedAt, confidence, errorKm: 1.5, method, sources: ["публичный статус", "демонстрационный сценарий"], lastConfirmedAt: updatedAt });

const trains = [
  {
    id:"uz-79-80", trainNumber:"79/80", transport:"train", name:"Поезд №79/80", type:"passenger", operationalStatus:"moving", route:"Львов → Днепр", routeId:"corridor-lviv-dnipro", regions:["lviv","ternopil","khmelnytskyi","vinnytsia","kyiv","poltava","dnipropetrovsk"],
    description:"Ночной пассажирский поезд дальнего следования. Положение рассчитывается по открытым событиям, задержке и геометрии пассажирского коридора; это не GNSS-трекинг.", rollingStock:"Локомотивная тяга, пассажирские вагоны", photo:photos.chs7, telemetry:{speedKph:72}, position:estimated(),
    schedule:[station("lviv","Львов",-150,places.lviv,"confirmed",8),station("ternopil","Тернополь",-72,places.ternopil,"confirmed",8),station("khmel","Хмельницкий",4,places.khmelnytskyi,"scheduled",8),station("vin","Винница",76,places.vinnytsia,"scheduled",8),station("kyiv","Киев-Пассажирский",190,places.kyiv,"scheduled",8),station("poltava","Полтава",330,places.poltava,"scheduled",8),station("dnipro","Днепр-Главный",430,places.dnipro,"scheduled",8)],
    history:[{timestamp:at(-150),label:"Отправление со станции Львов",coordinates:places.lviv},{timestamp:at(-72),label:"Событие станции Тернополь",coordinates:places.ternopil}]
  },
  {
    id:"uz-11-12", trainNumber:"11/12", transport:"train", name:"Поезд №11/12", type:"passenger", operationalStatus:"moving", route:"Одесса → Львов", routeId:"corridor-odesa-lviv", regions:["odesa","vinnytsia","khmelnytskyi","ternopil","lviv"],
    description:"Пассажирский поезд Одесского направления. Публичная задержка может быть добавлена официальным UZ-дашбордом, а координата остаётся расчётной.", rollingStock:"Пассажирский состав локомотивной тяги", photo:photos.chs7, telemetry:{speedKph:65}, position:estimated(at(-31)),
    schedule:[station("odesa","Одесса-Главная",-210,places.odesa,"confirmed",15),station("vin","Винница",-31,places.vinnytsia,"confirmed",15),station("khmel","Хмельницкий",58,places.khmelnytskyi,"scheduled",15),station("ternopil","Тернополь",118,places.ternopil,"scheduled",15),station("lviv","Львов",210,places.lviv,"scheduled",15)], history:[{timestamp:at(-210),label:"Одесса-Главная",coordinates:places.odesa},{timestamp:at(-31),label:"Винница",coordinates:places.vinnytsia}]
  },
  {
    id:"uz-15-16", trainNumber:"15/16", transport:"train", name:"Поезд №15/16", type:"passenger", operationalStatus:"moving", route:"Харьков → Ивано-Франковск", routeId:"corridor-kharkiv-ivano", regions:["kharkiv","poltava","kyiv","vinnytsia","khmelnytskyi","ternopil","ivano-frankivsk"],
    description:"Дальний пассажирский поезд восток—запад. В приложении используется только публичное расписание и укрупнённая оценка с заметной погрешностью.", rollingStock:"Пассажирский состав локомотивной тяги", photo:photos.chs7, telemetry:{speedKph:78}, position:estimated(at(-18)),
    schedule:[station("kharkiv","Харьков-Пассажирский",-240,places.kharkiv,"confirmed",22),station("poltava","Полтава",-142,places.poltava,"confirmed",22),station("kyiv","Киев-Пассажирский",-18,places.kyiv,"confirmed",22),station("vin","Винница",98,places.vinnytsia,"scheduled",22),station("ternopil","Тернополь",220,places.ternopil,"scheduled",22),station("ivano","Ивано-Франковск",310,places.ivano,"scheduled",22)], history:[{timestamp:at(-240),label:"Харьков-Пассажирский",coordinates:places.kharkiv},{timestamp:at(-142),label:"Полтава",coordinates:places.poltava},{timestamp:at(-18),label:"Киев-Пассажирский",coordinates:places.kyiv}]
  },
  {
    id:"uz-45-46", trainNumber:"45/46", transport:"train", name:"Поезд №45/46", type:"passenger", operationalStatus:"moving", route:"Харьков → Ужгород", routeId:"corridor-kharkiv-uzhhorod", regions:["kharkiv","poltava","kyiv","zhytomyr","vinnytsia","khmelnytskyi","ternopil","lviv","zakarpattia"],
    description:"Пассажирский поезд через центральные и западные области. Расчёт не раскрывает служебные, грузовые или военные перевозки.", rollingStock:"Пассажирский состав локомотивной тяги", photo:photos.chs7, telemetry:{speedKph:70}, position:estimated(at(-47)),
    schedule:[station("kharkiv","Харьков",-300,places.kharkiv,"confirmed",10),station("kyiv","Киев",-47,places.kyiv,"confirmed",10),station("vin","Винница",62,places.vinnytsia,"scheduled",10),station("lviv","Львов",245,places.lviv,"scheduled",10),station("muk","Мукачево",360,places.mukachevo,"scheduled",10),station("uzh","Ужгород",395,places.uzhhorod,"scheduled",10)], history:[{timestamp:at(-300),label:"Харьков",coordinates:places.kharkiv},{timestamp:at(-47),label:"Киев",coordinates:places.kyiv}]
  },
  {
    id:"uz-91-92", trainNumber:"91/92", transport:"train", name:"Поезд №91/92", type:"passenger", operationalStatus:"station", route:"Киев → Львов", routeId:"corridor-kyiv-lviv", regions:["kyiv","vinnytsia","khmelnytskyi","ternopil","lviv"],
    description:"Состав ожидает отправления на пассажирской станции. Статус станции сообщён сценарием, а не датчиком состава.", rollingStock:"Пассажирские вагоны", photo:photos.chs7, telemetry:{speedKph:0}, position:reported(places.kyiv,at(-6),"station-board-report",0.76), schedule:[], history:[{timestamp:at(-6),label:"Ожидает отправления",coordinates:places.kyiv}]
  },
  {
    id:"uz-105-106", trainNumber:"105/106", transport:"train", name:"Поезд №105/106", type:"passenger", operationalStatus:"moving", route:"Киев → Одесса", routeId:"corridor-kyiv-odesa", regions:["kyiv","kirovohrad","odesa"],
    description:"Пассажирский поезд южного направления. Для демонстрации используется представитель класса Intercity; фотография не подтверждает конкретный состав в рейсе.", rollingStock:"Электропоезд или пассажирский состав по назначению", photo:photos.hrcs2, telemetry:{speedKph:110}, position:estimated(at(-36)),
    schedule:[station("kyiv","Киев",-100,places.kyiv,"confirmed",4),station("fastiv","Фастов",-36,places.fastiv,"confirmed",4),station("krop","Кропивницкий",68,places.kropyvnytskyi,"scheduled",4),station("odesa","Одесса",190,places.odesa,"scheduled",4)], history:[{timestamp:at(-100),label:"Киев",coordinates:places.kyiv},{timestamp:at(-36),label:"Фастов",coordinates:places.fastiv}]
  },
  {
    id:"uz-117-118", trainNumber:"117/118", transport:"train", name:"Поезд №117/118", type:"passenger", operationalStatus:"depot", route:"Киев → Черновцы", routeId:"corridor-kyiv-chernivtsi", regions:["kyiv","vinnytsia","khmelnytskyi","chernivtsi"],
    description:"Состав отмечен в депо как демонстрация нового рабочего статуса. Без интеграции с системой депо это сообщение нельзя считать оперативным подтверждением.", rollingStock:"Пассажирские вагоны", photo:photos.chs7, telemetry:{speedKph:0}, position:reported([30.466,50.430],at(-24),"manual-depot-scenario",0.58), schedule:[], history:[{timestamp:at(-24),label:"Сообщение: в депо",coordinates:[30.466,50.430]}]
  },
  {
    id:"uz-779-780", trainNumber:"779/780", transport:"train", name:"Поезд №779/780", type:"commuter", operationalStatus:"station", route:"Сумы → Киев", routeId:"corridor-sumy-kyiv", regions:["sumy","chernihiv","kyiv"],
    description:"Региональный поезд на станции Сумы. Карточка показывает поддержку остановок, истории и областного фильтра.", rollingStock:"Региональный пассажирский состав", photo:photos.epl9t, telemetry:{speedKph:0}, position:reported(places.sumy,at(-3),"station-board-report",0.78), schedule:[], history:[{timestamp:at(-3),label:"Стоянка на станции Сумы",coordinates:places.sumy}]
  },
  {
    id:"uz-epl9t-015", trainNumber:"EPL9T-015", transport:"train", name:"ЭПЛ9Т-015", type:"commuter", operationalStatus:"depot", route:"Днепр → Запорожье", routeId:"corridor-dnipro-zaporizhzhia", regions:["dnipropetrovsk","zaporizhzhia"],
    description:"Пригородный электропоезд, показанный в депо как демонстрационный объект. Фотография отображает этот тип подвижного состава.", rollingStock:"Электропоезд ЭПЛ9Т", photo:photos.epl9t, telemetry:{speedKph:0}, position:reported([35.025,48.480],at(-70),"manual-depot-scenario",0.55), schedule:[], history:[{timestamp:at(-70),label:"Последнее сообщение депо",coordinates:[35.025,48.480]}]
  },
  {
    id:"uz-123-124", trainNumber:"123/124", transport:"train", name:"Поезд №123/124", type:"commuter", operationalStatus:"source-unavailable", route:"Киев → Чернигов", routeId:"corridor-kyiv-chernihiv", regions:["kyiv","chernihiv"],
    description:"Источник текущего положения недоступен. Маркер оставлен в последней публичной точке без попытки выдать её за актуальную.", rollingStock:"Региональный состав", photo:photos.epl9t, telemetry:{speedKph:null}, position:{status:"unknown",coordinates:places.chernihiv,updatedAt:at(-180),confidence:0,errorKm:null,method:"source-unavailable",sources:["публичное расписание"],lastConfirmedAt:null}, schedule:[], history:[]
  },
  {
    id:"uz-143-144", trainNumber:"143/144", transport:"train", name:"Поезд №143/144", type:"passenger", operationalStatus:"moving", route:"Львов → Луцк → Ровно", routeId:"corridor-lviv-lutsk", regions:["lviv","volyn","rivne"],
    description:"Региональный пассажирский маршрут, добавленный для покрытия Волынской и Ровненской областей.", rollingStock:"Пассажирский состав", photo:photos.chs7, telemetry:{speedKph:61}, position:estimated(at(-28)), schedule:[station("lviv","Львов",-110,places.lviv,"confirmed",3),station("lutsk","Луцк",-28,places.lutsk,"confirmed",3),station("rivne","Ровно",55,places.rivne,"scheduled",3)], history:[{timestamp:at(-110),label:"Львов",coordinates:places.lviv},{timestamp:at(-28),label:"Луцк",coordinates:places.lutsk}]
  },
  {
    id:"uz-109-110", trainNumber:"109/110", transport:"train", name:"Поезд №109/110", type:"passenger", operationalStatus:"source-unavailable", route:"Киев → Херсон", routeId:"corridor-kyiv-kherson", regions:["kyiv","cherkasy","kirovohrad","mykolaiv","kherson"],
    description:"Маршрут включён для территориального покрытия, но текущая позиция намеренно не рассчитывается без надёжного публичного события.", rollingStock:"Пассажирский состав", photo:photos.chs7, telemetry:{speedKph:null}, position:{status:"unknown",coordinates:places.mykolaiv,updatedAt:at(-240),confidence:0,errorKm:null,method:"source-unavailable",sources:["маршрутный справочник"],lastConfirmedAt:null}, schedule:[], history:[]
  }
];

const trainsData = { schemaVersion:2, generatedAt:base.toISOString(), demoMode:true, dataMode:"public-schedule-scenarios", safetyNote:"Только пассажирские маршруты. Грузовые, служебные и военные перевозки не отображаются.", objects:trains };
const vesselsData = { schemaVersion:2, generatedAt:base.toISOString(), demoMode:false, sourceStatus:{status:"unavailable",label:"AIS-провайдер не подключён",details:"Морские позиции не подменяются демонстрационными координатами."}, objects:[] };

await Promise.all([
  writeFile(new URL("../data/trains.json", import.meta.url), `${JSON.stringify(trainsData,null,2)}\n`),
  writeFile(new URL("../data/vessels.json", import.meta.url), `${JSON.stringify(vesselsData,null,2)}\n`),
  writeFile(new URL("../data/railways.geojson", import.meta.url), `${JSON.stringify({type:"FeatureCollection",features:routeFeatures},null,2)}\n`),
]);
console.log(`Built ${trains.length} public passenger scenarios and ${routeFeatures.length} corridors.`);
