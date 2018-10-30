'use strict';
const Cache = require('@parcel/cache');
const {mkdirp} = require('@parcel/fs');
const {matchConfig} = require('@parcel/utils');
const path = require('path');

class PackagerRunner {
  constructor({parcelConfig, cliOpts}) {
    this.parcelConfig = parcelConfig;
    this.cache = new Cache({parcelConfig, cliOpts});
    this.dirExists = false;
  }

  async runPackager(bundle) {
    let {packagers} = this.parcelConfig;
    let {name = 'file.' + bundle.type} = bundle;

    console.log('Bundle', bundle, bundle.constructor);
    let packager = matchConfig(packagers, name);

    if (!packager) {
      throw new Error(
        `Could not find packager for bundle of type "${bundle.type}"`
      );
    }

    // TODO(fathyb): use ConfigRunner
    packager = require(packager);

    let modulesContents = await Promise.all(
      bundle.assets.map(async asset => {
        let blobs = await this.cache.readBlobs(asset);
        let result = await packager.asset({blobs});

        return result;
      })
    );

    let packageFileContents = await packager.package(modulesContents);

    if (!this.dirExists) {
      await mkdirp(path.dirname(bundle.destPath));
      this.dirExists = true;
    }

    await packager.writeFile({
      filePath: bundle.destPath,
      fileContents: packageFileContents
    });
  }
}

module.exports = PackagerRunner;
