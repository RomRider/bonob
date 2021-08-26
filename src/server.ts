import { option as O } from "fp-ts";
import express, { Express, Request } from "express";
import * as Eta from "eta";
import morgan from "morgan";
import path from "path";
import sharp from "sharp";
import fs from "fs";

import { PassThrough, Transform, TransformCallback } from "stream";

import { Sonos, Service, SONOS_LANG } from "./sonos";
import {
  SOAP_PATH,
  STRINGS_ROUTE,
  PRESENTATION_MAP_ROUTE,
  SONOS_RECOMMENDED_IMAGE_SIZES,
  LOGIN_ROUTE,
  CREATE_REGISTRATION_ROUTE,
  REMOVE_REGISTRATION_ROUTE,
  ICON,
} from "./smapi";
import { LinkCodes, InMemoryLinkCodes } from "./link_codes";
import { MusicService, isSuccess } from "./music_service";
import bindSmapiSoapServiceToExpress from "./smapi";
import { AccessTokens, AccessTokenPerAuthToken } from "./access_tokens";
import logger from "./logger";
import { Clock, SystemClock } from "./clock";
import { pipe } from "fp-ts/lib/function";
import { URLBuilder } from "./url_builder";
import makeI8N, { asLANGs, KEY, keys as i8nKeys, LANG } from "./i8n";
import { SvgIcon, Icon, makeFestive } from "./icon";

export const BONOB_ACCESS_TOKEN_HEADER = "bonob-access-token";

interface RangeFilter extends Transform {
  range: (length: number) => string;
}

export function rangeFilterFor(rangeHeader: string): RangeFilter {
  // if (rangeHeader == undefined) return new PassThrough();
  const match = rangeHeader.match(/^bytes=(\d+)-$/);
  if (match) return new RangeBytesFromFilter(Number.parseInt(match[1]!));
  else throw `Unsupported range: ${rangeHeader}`;
}

export class RangeBytesFromFilter extends Transform {
  from: number;
  count: number = 0;

  constructor(f: number) {
    super();
    this.from = f;
  }

  _transform(chunk: any, _: BufferEncoding, next: TransformCallback) {
    if (this.count + chunk.length <= this.from) {
      // before start
      next();
    } else if (this.from <= this.count) {
      // off the end
      next(null, chunk);
    } else {
      // from somewhere in chunk
      next(null, chunk.slice(this.from - this.count));
    }
    this.count = this.count + chunk.length;
  }

  range = (number: number) => `${this.from}-${number - 1}/${number}`;
}

function server(
  sonos: Sonos,
  service: Service,
  bonobUrl: URLBuilder,
  musicService: MusicService,
  linkCodes: LinkCodes = new InMemoryLinkCodes(),
  accessTokens: AccessTokens = new AccessTokenPerAuthToken(),
  clock: Clock = SystemClock,
  iconColors: {
    foregroundColor: string | undefined;
    backgroundColor: string | undefined;
  } = { foregroundColor: undefined, backgroundColor: undefined },
  applyContextPath = true
): Express {
  const app = express();
  const i8n = makeI8N(service.name);

  app.use(morgan("combined"));
  app.use(express.urlencoded({ extended: false }));

  // todo: pass options in here?
  app.use(express.static("./web/public"));
  app.engine("eta", Eta.renderFile);

  app.set("view engine", "eta");
  app.set("views", path.resolve(__dirname, "..", "web", "views"));

  const langFor = (req: Request) => {
    logger.debug(
      `${req.path} (req[accept-language]=${req.headers["accept-language"]})`
    );
    return i8n(...asLANGs(req.headers["accept-language"]));
  };

  const iconFrom = (name: string) =>
    makeFestive(
      new SvgIcon(
        fs.readFileSync(path.resolve(__dirname, "..", "web", "icons", name)).toString()
      ).with({ viewPortIncreasePercent: 50, ...iconColors }),
      clock
    );

  const ICONS: Record<ICON, Icon> = {
    artists: iconFrom("navidrome-artists.svg"),
    albums: iconFrom("navidrome-all.svg"),
    playlists: iconFrom("navidrome-playlists.svg"),
    genres: iconFrom("Theatre-Mask-111172.svg"),
    random: iconFrom("navidrome-random.svg"),
    starred: iconFrom("navidrome-topRated.svg"),
    recentlyAdded: iconFrom("navidrome-recentlyAdded.svg"),
    recentlyPlayed: iconFrom("navidrome-recentlyPlayed.svg"),
    mostPlayed: iconFrom("navidrome-mostPlayed.svg"),
    discover: iconFrom("Binoculars-14310.svg"),
  };

  app.get("/", (req, res) => {
    const lang = langFor(req);
    Promise.all([sonos.devices(), sonos.services()]).then(
      ([devices, services]) => {
        const registeredBonobService = services.find(
          (it) => it.sid == service.sid
        );
        res.render("index", {
          lang,
          devices,
          services,
          bonobService: service,
          registeredBonobService,
          createRegistrationRoute: bonobUrl
            .append({ pathname: CREATE_REGISTRATION_ROUTE })
            .pathname(),
          removeRegistrationRoute: bonobUrl
            .append({ pathname: REMOVE_REGISTRATION_ROUTE })
            .pathname(),
        });
      }
    );
  });

  app.get("/about", (_, res) => {
    return res.send({
      service: {
        name: service.name,
        sid: service.sid,
      },
    });
  });

  app.post(CREATE_REGISTRATION_ROUTE, (req, res) => {
    const lang = langFor(req);
    sonos.register(service).then((success) => {
      if (success) {
        res.render("success", {
          lang,
          message: lang("successfullyRegistered"),
        });
      } else {
        res.status(500).render("failure", {
          lang,
          message: lang("registrationFailed"),
        });
      }
    });
  });

  app.post(REMOVE_REGISTRATION_ROUTE, (req, res) => {
    const lang = langFor(req);
    sonos.remove(service.sid).then((success) => {
      if (success) {
        res.render("success", {
          lang,
          message: lang("successfullyRemovedRegistration"),
        });
      } else {
        res.status(500).render("failure", {
          lang,
          message: lang("failedToRemoveRegistration"),
        });
      }
    });
  });

  app.get(LOGIN_ROUTE, (req, res) => {
    const lang = langFor(req);
    res.render("login", {
      lang,
      linkCode: req.query.linkCode,
      loginRoute: bonobUrl.append({ pathname: LOGIN_ROUTE }).pathname(),
    });
  });

  app.post(LOGIN_ROUTE, async (req, res) => {
    const lang = langFor(req);
    const { username, password, linkCode } = req.body;
    if (!linkCodes.has(linkCode)) {
      res.status(400).render("failure", {
        lang,
        message: lang("invalidLinkCode"),
      });
    } else {
      const authResult = await musicService.generateToken({
        username,
        password,
      });
      if (isSuccess(authResult)) {
        linkCodes.associate(linkCode, authResult);
        res.render("success", {
          lang,
          message: lang("loginSuccessful"),
        });
      } else {
        res.status(403).render("failure", {
          lang,
          message: lang("loginFailed"),
          cause: authResult.message,
        });
      }
    }
  });

  app.get(STRINGS_ROUTE, (_, res) => {
    const stringNode = (id: string, value: string) =>
      `<string stringId="${id}"><![CDATA[${value}]]></string>`;
    const stringtableNode = (langName: string) =>
      `<stringtable rev="1" xml:lang="${langName}">${i8nKeys()
        .map((key) => stringNode(key, i8n(langName as LANG)(key as KEY)))
        .join("")}</stringtable>`;

    res.type("application/xml").send(`<?xml version="1.0" encoding="utf-8" ?>
<stringtables xmlns="http://sonos.com/sonosapi">
    ${SONOS_LANG.map(stringtableNode).join("")}
</stringtables>
`);
  });

  app.get(PRESENTATION_MAP_ROUTE, (_, res) => {
    res.type("application/xml").send(`<?xml version="1.0" encoding="utf-8" ?>
    <Presentation>
      <PresentationMap type="ArtWorkSizeMap">
        <Match>
          <imageSizeMap>
            ${SONOS_RECOMMENDED_IMAGE_SIZES.map(
              (size) =>
                `<sizeEntry size="${size}" substitution="/size/${size}"/>`
            ).join("")}
          </imageSizeMap>
        </Match>
      </PresentationMap>
      <PresentationMap type="BrowseIconSizeMap">
        <Match>
          <browseIconSizeMap>
              <sizeEntry size="0" substitution="/size/legacy"/>
              ${SONOS_RECOMMENDED_IMAGE_SIZES.map(
                (size) =>
                  `<sizeEntry size="${size}" substitution="/size/${size}"/>`
              ).join("")}
            </browseIconSizeMap>
        </Match>
      </PresentationMap>
      <PresentationMap type="Search">
        <Match>
          <SearchCategories>
              <Category id="artists"/>
              <Category id="albums"/>
              <Category id="tracks"/>
          </SearchCategories>
        </Match>
      </PresentationMap>
    </Presentation>`);
  });

  app.get("/stream/track/:id", async (req, res) => {
    const id = req.params["id"]!;
    logger.info(
      `-> /stream/track/${id}, headers=${JSON.stringify(req.headers)}`
    );
    const authToken = pipe(
      req.header(BONOB_ACCESS_TOKEN_HEADER),
      O.fromNullable,
      O.map((accessToken) => accessTokens.authTokenFor(accessToken)),
      O.getOrElseW(() => undefined)
    );
    if (!authToken) {
      return res.status(401).send();
    } else {
      return musicService
        .login(authToken)
        .then((it) =>
          it
            .stream({
              trackId: id,
              range: req.headers["range"] || undefined,
            })
            .then((stream) => ({ musicLibrary: it, stream }))
        )
        .then(({ musicLibrary, stream }) => {
          logger.info(
            `stream response from music service for ${id}, status=${
              stream.status
            }, headers=(${JSON.stringify(stream.headers)})`
          );

          const respondWith = ({
            status,
            filter,
            headers,
            sendStream,
            nowPlaying,
          }: {
            status: number;
            filter: Transform;
            headers: Record<string, string | undefined>;
            sendStream: boolean;
            nowPlaying: boolean;
          }) => {
            logger.info(
              `<- /stream/track/${id}, status=${status}, headers=${JSON.stringify(
                headers
              )}`
            );
            (nowPlaying
              ? musicLibrary.nowPlaying(id)
              : Promise.resolve(true)
            ).then((_) => {
              res.status(status);
              Object.entries(stream.headers)
                .filter(([_, v]) => v !== undefined)
                .forEach(([header, value]) => res.setHeader(header, value));
              if (sendStream) stream.stream.pipe(filter).pipe(res);
              else res.send();
            });
          };

          if (stream.status == 200) {
            respondWith({
              status: 200,
              filter: new PassThrough(),
              headers: {
                "content-type": stream.headers["content-type"],
                "content-length": stream.headers["content-length"],
                "accept-ranges": stream.headers["accept-ranges"],
              },
              sendStream: req.method == "GET",
              nowPlaying: req.method == "GET",
            });
          } else if (stream.status == 206) {
            respondWith({
              status: 206,
              filter: new PassThrough(),
              headers: {
                "content-type": stream.headers["content-type"],
                "content-length": stream.headers["content-length"],
                "content-range": stream.headers["content-range"],
                "accept-ranges": stream.headers["accept-ranges"],
              },
              sendStream: req.method == "GET",
              nowPlaying: req.method == "GET",
            });
          } else {
            respondWith({
              status: stream.status,
              filter: new PassThrough(),
              headers: {},
              sendStream: req.method == "GET",
              nowPlaying: false,
            });
          }
        });
    }
  });

  app.get("/icon/:type/size/:size", (req, res) => {
    const type = req.params["type"]!;
    const size = req.params["size"]!;

    if (!Object.keys(ICONS).includes(type)) {
      return res.status(404).send();
    } else if (
      size != "legacy" &&
      !SONOS_RECOMMENDED_IMAGE_SIZES.includes(size)
    ) {
      return res.status(400).send();
    } else {
      const icon = (ICONS as any)[type]! as Icon;
      const spec =
        size == "legacy"
          ? {
              mimeType: "image/png",
              responseFormatter: (svg: string): Promise<Buffer | string> =>
                sharp(Buffer.from(svg)).resize(80).png().toBuffer(),
            }
          : {
              mimeType: "image/svg+xml",
              responseFormatter: (svg: string): Promise<Buffer | string> =>
                Promise.resolve(svg),
            };

      return Promise.resolve(icon.toString())
        .then(spec.responseFormatter)
        .then((data) => res.status(200).type(spec.mimeType).send(data));
    }
  });

  app.get("/art/:type/:id/size/:size", (req, res) => {
    const authToken = accessTokens.authTokenFor(
      req.query[BONOB_ACCESS_TOKEN_HEADER] as string
    );
    const type = req.params["type"]!;
    const id = req.params["id"]!;
    const size = req.params["size"]!;
    if (!authToken) {
      return res.status(401).send();
    } else if (type != "artist" && type != "album") {
      return res.status(400).send();
    } else if (!(size.match(/^\d+$/) && Number.parseInt(size) > 0)) {
      return res.status(400).send();
    } else {
      return musicService
        .login(authToken)
        .then((it) => it.coverArt(id, type, Number.parseInt(size)))
        .then((coverArt) => {
          if (coverArt) {
            res.status(200);
            res.setHeader("content-type", coverArt.contentType);
            return res.send(coverArt.data);
          } else {
            return res.status(404).send();
          }
        })
        .catch((e: Error) => {
          logger.error(`Failed fetching image ${type}/${id}/size/${size}`, {
            cause: e,
          });
          return res.status(500).send();
        });
    }
  });

  bindSmapiSoapServiceToExpress(
    app,
    SOAP_PATH,
    bonobUrl,
    linkCodes,
    musicService,
    accessTokens,
    clock,
    i8n
  );

  if (applyContextPath) {
    const container = express();
    container.use(bonobUrl.path(), app);
    return container;
  } else {
    return app;
  }
}

export default server;
