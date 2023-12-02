import {
  BaseSource,
  Item,
  SourceOptions,
} from "https://deno.land/x/ddu_vim@v3.7.0/types.ts";
import { Denops, fn } from "https://deno.land/x/ddu_vim@v3.7.0/deps.ts";
import { ActionData } from "https://deno.land/x/ddu_kind_file@v0.7.1/file.ts";
import { join, resolve } from "https://deno.land/std@0.208.0/path/mod.ts";
import { abortable } from "https://deno.land/std@0.208.0/async/mod.ts";
import * as frontmatter from "https://deno.land/std@0.208.0/front_matter/any.ts";
import * as yaml from "https://deno.land/std@0.208.0/yaml/mod.ts";

type Params = Record<never, never>;
type Args = {
  denops: Denops;
  sourceOptions: SourceOptions;
};

export class Source extends BaseSource<Params> {
  kind = "file";

  gather(
    { denops, sourceOptions }: Args,
  ): ReadableStream<Item<ActionData>[]> {
    const abortController = new AbortController();
    return new ReadableStream({
      async start(controller) {
        const root = (sourceOptions.path || await fn.getcwd(denops)) as string;
        const it = walk(
          resolve(root, root),
          abortController.signal,
          1000,
        );
        let enqueueSize = 1000;
        let items: Item<ActionData>[] = [];
        try {
          for await (const chunk of it) {
            items = items.concat(chunk);
            if (items.length >= enqueueSize) {
              enqueueSize = 10 * 1000;
              controller.enqueue(items);
              items = [];
            }
          }
          if (items.length) {
            controller.enqueue(items);
          }
        } catch (e: unknown) {
          if (e instanceof DOMException) {
            return;
          }
          console.error(e);
        } finally {
          controller.close();
        }
      },
    });
  }

  params(): Params {
    return {};
  }
}

async function* walk(
  root: string,
  signal: AbortSignal,
  chunkSize: number,
): AsyncGenerator<Item<ActionData>[]> {
  const walk = async function* (
    dir: string,
  ): AsyncGenerator<Item<ActionData>[]> {
    let chunk: Item<ActionData>[] = [];
    try {
      for await (const entry of abortable(Deno.readDir(dir), signal)) {
        const abspath = join(dir, entry.name);
        const isArticle = /.*\/articles/.test(abspath);
        const isBook = /.*\/books/.test(abspath);
        const isZennDirectory = isArticle || isBook;

        if (!entry.isDirectory) {
          if (!isZennDirectory) continue;
          if (!/\.md$/.test(entry.name)) continue;

          let word: string;
          const file = await Deno.readTextFile(abspath);
          if (isArticle) {
            // article
            const { attrs } = frontmatter.extract<{ title: string }>(
              file,
            );
            word = `📝: ${attrs.title}`;
          } else {
            // book
            const configFileName =
              abspath.slice(0, abspath.search(entry.name)) +
              "config.yaml";
            const configFile = await Deno.readTextFile(configFileName);
            const config = yaml.parse(configFile) as { title: string };
            const { attrs } = frontmatter.extract<{ title: string }>(
              file,
            );
            word = `🔖: ${config.title}/${attrs.title}`;
          }

          if (!word) continue;
          const n = chunk.push({
            word,
            action: {
              path: abspath,
              isDirectory: false,
            },
          });
          if (n >= chunkSize) {
            yield chunk;
            chunk = [];
          }
        } else {
          if (!isZennDirectory) {
            continue;
          }
          yield* walk(abspath);
        }
      }
      if (chunk.length) {
        yield chunk;
      }
    } catch (e: unknown) {
      if (e instanceof Deno.errors.PermissionDenied) {
        // Ignore this error
        // See https://github.com/Shougo/ddu-source-file_rec/issues/2
        return;
      }
      throw e;
    }
  };
  yield* walk(root);
}
