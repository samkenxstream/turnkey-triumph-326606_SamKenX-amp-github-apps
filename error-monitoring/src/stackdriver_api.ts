/**
 * Copyright 2020 The AMP HTML Authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {GaxiosOptions} from 'gaxios';
import {GoogleAuth} from 'google-auth-library';
import {Stackdriver} from 'error-monitoring';
import NodeCache from 'node-cache';

const SERVICE = 'https://clouderrorreporting.googleapis.com';
const SECONDS_IN_HOUR = 60 * 60;
const SECONDS_IN_DAY = SECONDS_IN_HOUR * 24;
const CACHE_TTL = SECONDS_IN_HOUR;
const GAUTH_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export class StackdriverApi {
  private auth = new GoogleAuth({scopes: GAUTH_SCOPE});
  private cache = new NodeCache({stdTTL: CACHE_TTL});

  constructor(private projectId: string) {}

  /** Makes a request to the Cloud Error Reporting API. */
  private async request(
    endpoint: string,
    method: 'GET' | 'PUT',
    body?: Record<string, unknown>
  ): Promise<unknown> {
    const client = await this.auth.getClient();
    const opts: GaxiosOptions = {
      url: `${SERVICE}/v1beta1/projects/${this.projectId}/${endpoint}`,
      method,
    };

    if (method === 'GET') {
      opts.params = body;
    } else {
      opts.body = JSON.stringify(body);
    }

    return client.request(opts).then(({data}) => data);
  }

  private deserialize({
    group,
    count,
    timedCounts,
    firstSeenTime,
    representative,
    numAffectedServices,
    affectedServices,
  }: Stackdriver.SerializedErrorGroupStats): Stackdriver.ErrorGroupStats {
    return {
      group,
      count: Number(count),
      timedCounts: timedCounts.map(tc => ({
        count: Number(tc.count),
        startTime: new Date(tc.startTime),
        endTime: new Date(tc.endTime),
      })),
      firstSeenTime: new Date(firstSeenTime),
      numAffectedServices: Number(numAffectedServices),
      affectedServices,
      representative: {message: representative.message},
    };
  }

  /**
   * Fetch one or more error groups from the Stackdriver API.
   * See https://cloud.google.com/error-reporting/reference/rest/v1beta1/projects.groupStats/list
   */
  private async getGroups(opts: {
    pageSize?: number;
    groupId?: string;
    'serviceFilter.service'?: string;
  }): Promise<Array<Stackdriver.ErrorGroupStats>> {
    const serviceKey = opts['serviceFilter.service'] || 'ALL_SERVICES';
    const groupKey = opts.groupId || 'NO_GROUP';
    const cacheKey = `${serviceKey}-${groupKey}`.replace(/\n|\r/g, '');
    let errorGroups: undefined | Array<Stackdriver.ErrorGroupStats> =
      this.cache.get(cacheKey);

    if (!errorGroups) {
      const {errorGroupStats = []} = (await this.request('groupStats', 'GET', {
        'timeRange.period': 'PERIOD_1_DAY',
        timedCountDuration: `${SECONDS_IN_DAY}s`,
        ...opts,
      })) as {errorGroupStats?: Array<Stackdriver.SerializedErrorGroupStats>};

      errorGroups = errorGroupStats.map(this.deserialize, this);
      this.cache.set(cacheKey, errorGroups);
    } else {
      console.info(
        `Returning Stackdriver results from local cache for key "${cacheKey}"`
      );
    }

    return errorGroups;
  }

  /** List groups of errors. */
  async listGroups(pageSize = 20): Promise<Array<Stackdriver.ErrorGroupStats>> {
    console.info(`Fetching first ${pageSize} error groups`);
    return this.getGroups({pageSize});
  }

  /** List groups of errors for a particular service group. */
  async listServiceGroups(
    serviceName: string,
    pageSize = 20
  ): Promise<Array<Stackdriver.ErrorGroupStats>> {
    console.info(`Fetching first ${pageSize} error groups for ${serviceName}`);
    return this.getGroups({
      pageSize,
      'serviceFilter.service': serviceName,
    });
  }

  /** Get details about an error group. */
  async getGroup(groupId: string): Promise<Stackdriver.ErrorGroupStats> {
    console.info(`Fetching group stats for error group "${groupId}"`);
    const errorGroupStats = await this.getGroups({groupId});
    return errorGroupStats[0];
  }

  /**
   * Sets the tracking issue for an error group.
   * See https://cloud.google.com/error-reporting/reference/rest/v1beta1/projects.groups/update
   */
  async setGroupIssue(
    groupId: string,
    issueUrl: string
  ): Promise<Stackdriver.ErrorGroup> {
    console.info(
      `Updating tracking issue for error group "${groupId}" to "${issueUrl}"`
    );
    this.cache.flushAll();
    return this.request(`groups/${groupId}`, 'PUT', {
      trackingIssues: [{url: issueUrl}],
    }) as Promise<Stackdriver.ErrorGroup>;
  }
}
