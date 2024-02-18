#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { CDKStack } from "./stack";

const app = new cdk.App();

const defaultProps = {
  dbCapacity: [0.5, 1],
  containerCpu: 512,
  containerMemory: 1024,
  redisType: "cache.t2.micro",
  useMailContainer: true,
};

new CDKStack(app, "app-staging", {
  env: {
    account: "accountId",
    region: "eu-west-2",
  },
  domain: "staging.domain.com",
  envSecretId: "your staging secret arn",
  resources: defaultProps,
});

new CDKStack(app, "app-prod", {
  env: {
    account: "accountId",
    region: "eu-west-2",
  },
  domain: "domain.com",
  envSecretId: "your production secret arn",
  resources: {
    ...defaultProps,
    redisType: "cache.t3.medium",
    dbCapacity: [0.5, 3],
    containerCpu: 2048,
    containerMemory: 4096,
  },
});
