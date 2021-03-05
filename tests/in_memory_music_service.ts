import { option as O } from "fp-ts";
import { pipe } from "fp-ts/lib/function";


import {
  MusicService,
  Credentials,
  AuthSuccess,
  AuthFailure,
  Artist,
  MusicLibrary,
  ArtistQuery,
  AlbumQuery,
  slice2,
  asResult,
  ArtistSummary,
  Album,
  AlbumSummary
} from "../src/music_service";

export const artistToArtistSummary = (
  it: Artist
): ArtistSummary => ({
  id: it.id,
  name: it.name,
  image: it.image,
});

export const albumToAlbumSummary = (
  it: Album
): AlbumSummary => ({
  id: it.id,
  name: it.name,
  year: it.year,
  genre: it.genre,
});

type P<T> = (t: T) => boolean;
const all: P<any> = (_: any) => true;
const artistWithId = (id: string): P<Artist> => (artist: Artist) =>
  artist.id === id;

export class InMemoryMusicService implements MusicService {
  users: Record<string, string> = {};
  artists: Artist[] = [];

  generateToken({
    username,
    password,
  }: Credentials): Promise<AuthSuccess | AuthFailure> {
    if (
      username != undefined &&
      password != undefined &&
      this.users[username] == password
    ) {
      return Promise.resolve({
        authToken: JSON.stringify({ username, password }),
        userId: username,
        nickname: username,
      });
    } else {
      return Promise.resolve({ message: `Invalid user:${username}` });
    }
  }

  login(token: string): Promise<MusicLibrary> {
    const credentials = JSON.parse(token) as Credentials;
    if (this.users[credentials.username] != credentials.password)
      return Promise.reject("Invalid auth token");
    return Promise.resolve({
      artists: (q: ArtistQuery) =>
        Promise.resolve(this.artists.map(artistToArtistSummary))
          .then(slice2(q))
          .then(asResult),
      artist: (id: string) =>
        pipe(
          this.artists.find((it) => it.id === id),
          O.fromNullable,
          O.map(it => Promise.resolve(it)),
          O.getOrElse(() => Promise.reject(`No artist with id '${id}'`))
        ),
      albums: (q: AlbumQuery) =>
        Promise.resolve(
          this.artists.filter(
            pipe(
              O.fromNullable(q.artistId),
              O.map(artistWithId),
              O.getOrElse(() => all)
            )
          )
        )
          .then((artists) => artists.flatMap((it) => it.albums))
          .then(it => it.map(albumToAlbumSummary))
          .then(slice2(q))
          .then(asResult),
      // album: (id: albumId) => Promise.resolve(this.artists.flatMap(it => it.albums).find(it => it.id === id))
    });
  }

  hasUser(credentials: Credentials) {
    this.users[credentials.username] = credentials.password;
    return this;
  }

  hasNoUsers() {
    this.users = {};
    return this;
  }

  hasArtists(...newArtists: Artist[]) {
    this.artists = [...this.artists, ...newArtists];
    return this;
  }

  clear() {
    this.users = {};
    this.artists = [];
    return this;
  }
}
