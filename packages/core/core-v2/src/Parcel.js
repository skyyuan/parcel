// @flow
'use strict';
import {AbortController} from 'abortcontroller-polyfill/dist/cjs-ponyfill';
import Watcher from '@parcel/watcher';
import PromiseQueue from './PromiseQueue';
import AssetGraph from './AssetGraph';
import {Node} from './Graph';
import type {Dependency, Asset, File} from './types';
import TransformerRunner from './TransformerRunner';
import ResolverRunner from './ResolverRunner';
import BundlerRunner from './BundlerRunner';
import PackagerRunner from './PackagerRunner';

// TODO: use custom config if present
const defaultConfig = require('@parcel/config-default');

const abortError = new Error('Build aborted');

type CliOpts = {
  watch?: boolean
};

type ParcelOpts = {
  entries: Array<string>,
  cwd?: string,
  cliOpts: CliOpts
};

type Signal = {
  aborted: boolean,
  addEventListener?: Function
};

type BuildOpts = {
  signal: Signal,
  shallow?: boolean
};

export default class Parcel {
  entries: Array<string>;
  rootDir: string;
  graph: AssetGraph;
  watcher: Watcher;
  queue: PromiseQueue;
  transformerRunner: TransformerRunner;
  resolverRunner: ResolverRunner;
  bundlerRunner: BundlerRunner;
  packagerRunner: PackagerRunner;

  constructor({entries, cliOpts = {}}: ParcelOpts) {
    this.rootDir = process.cwd();

    this.graph = new AssetGraph({entries, rootDir: this.rootDir});
    this.watcher = cliOpts.watch ? new Watcher() : null;
    this.queue = new PromiseQueue();

    this.transformerRunner = new TransformerRunner({
      parcelConfig: defaultConfig,
      cliOpts
    });
    this.resolverRunner = new ResolverRunner();
    this.bundlerRunner = new BundlerRunner({
      parcelConfig: defaultConfig,
      cliOpts
    });
    this.packagerRunner = new PackagerRunner({
      parcelConfig: defaultConfig,
      cliOpts
    });
  }

  async run() {
    let controller = new AbortController();
    let signal = controller.signal;

    let buildPromise = this.build({signal});

    if (this.watcher) {
      this.watcher.on('change', filePath => {
        if (this.graph.hasNode(filePath)) {
          controller.abort();
          this.graph.invalidateNodeById(filePath);

          controller = new AbortController();
          signal = controller.signal;

          this.build({signal});
        }
      });
    }

    await buildPromise;
  }

  async build({signal}: BuildOpts) {
    try {
      console.log('Starting build');
      await this.updateGraph({signal});
      await this.completeGraph({signal});
      // await this.graph.dumpGraphViz();
      let {bundles} = await this.bundle();
      await this.package(bundles);
      console.log('Finished build');
    } catch (e) {
      if (e !== abortError) {
        console.error(e);
      }
    }
  }

  async updateGraph({signal}: BuildOpts) {
    for (let [id, node] of this.graph.invalidNodes) {
      this.processNode(node, {signal, shallow: true});
    }

    await this.queue.run();
  }

  async completeGraph({signal}: BuildOpts) {
    for (let [id, node] of this.graph.incompleteNodes) {
      this.processNode(node, {signal});
    }

    await this.queue.run();
  }

  processNode(node: Node, buildOpts: BuildOpts) {
    switch (node.type) {
      case 'dependency':
        return this.resolve(node.value, buildOpts);
      case 'file':
        return this.transform(node.value, buildOpts);
      default:
        throw new Error('Invalid Graph');
    }
  }

  resolve(dep: Dependency, {signal}: BuildOpts) {
    return this.queue.add(async () => {
      // console.log('resolving dependency', dep);
      let resolvedPath = await this.resolverRunner.resolve(dep);

      if (signal.aborted) throw abortError;

      let file = {filePath: resolvedPath};
      let {newFile} = this.graph.updateDependency(dep, file);

      if (newFile) {
        this.transform(newFile, {signal});
        if (this.watcher) this.watcher.watch(newFile.filePath);
      }
    });
  }

  transform(file: File, {signal, shallow}: BuildOpts) {
    return this.queue.add(async () => {
      // console.log('transforming file', file);
      let {children: childAssets} = await this.transformerRunner.transform(
        file
      );

      if (signal.aborted) throw abortError;

      let {prunedFiles, newDeps} = this.graph.updateFile(file, childAssets);

      if (this.watcher) {
        for (let file of prunedFiles) {
          this.watcher.unwatch(file.filePath);
        }
      }

      // The shallow option is used during the update phase
      if (!shallow) {
        for (let dep of newDeps) {
          this.resolve(dep, {signal});
        }
      }
    });
  }

  bundle() {
    return this.bundlerRunner.bundle(this.graph);
  }

  // TODO: implement bundle types
  package(bundles: any) {
    return Promise.all(
      bundles.map(bundle => this.packagerRunner.runPackager({bundle}))
    );
  }
}
