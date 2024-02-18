import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as rds from "aws-cdk-lib/aws-rds";
import * as asm from "aws-cdk-lib/aws-secretsmanager";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as kms from "aws-cdk-lib/aws-kms";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import { ManagedPolicy, PolicyStatement } from "aws-cdk-lib/aws-iam";
import {
  InstanceType,
  Connections,
  Port,
  SubnetType,
} from "aws-cdk-lib/aws-ec2";
import { Aspects, Duration, Token } from "aws-cdk-lib";

import {
  ApplicationProtocol,
  SslPolicy,
} from "aws-cdk-lib/aws-elasticloadbalancingv2";
import {
  Certificate,
  CertificateValidation,
} from "aws-cdk-lib/aws-certificatemanager";
import { LogGroup } from "aws-cdk-lib/aws-logs";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";

const secretEnvKeys = [
  // Define a list of secret keys that will be imported from secrets manager
];

// These values will be passed through from
interface CDKStackProps extends cdk.StackProps {
  domain: string;
  envSecretId: string;
  resources: {
    dbCapacity: number[];
    containerCpu: number;
    containerMemory: number;
    redisType: string;
  };
}

export class CDKStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CDKStackProps) {
    super(scope, id, props);

    const buildResourceId = (suffix: string) => `${id.toLowerCase()}-${suffix}`;

    const vpc = new ec2.Vpc(this, buildResourceId("vpc"), {
      maxAzs: 2,
      natGateways: 1,
      vpcName: buildResourceId("vpc"),
    });

    const kmsKey = new kms.Key(this, buildResourceId("kms-key"), {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Pass the KMS key in the `encryptionKey` field to associate the key to the log group
    const logGroup = new LogGroup(this, buildResourceId("log-group"), {
      encryptionKey: kmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Pass the KMS key in the `encryptionKey` field to associate the key to the S3 bucket
    const execBucket = new s3.Bucket(this, buildResourceId("ecs-exec-bucket"), {
      encryptionKey: kmsKey,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cluster = new ecs.Cluster(this, buildResourceId("cluster"), {
      vpc: vpc,
      clusterName: buildResourceId("cluster"),
      executeCommandConfiguration: {
        kmsKey,
        logConfiguration: {
          cloudWatchLogGroup: logGroup,
          cloudWatchEncryptionEnabled: true,
          s3Bucket: execBucket,
          s3EncryptionEnabled: true,
          s3KeyPrefix: "exec-command-output",
        },
        logging: ecs.ExecuteCommandLogging.OVERRIDE,
      },
    });

    const ecrRepository = ecr.Repository.fromRepositoryName(
      this,
      buildResourceId("ecr-repository"),
      buildResourceId("ecr-repository")
    );

    const bucket = new s3.Bucket(this, buildResourceId("bucket"), {
      bucketName: buildResourceId("bucket"),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      publicReadAccess: true,
      accessControl: s3.BucketAccessControl.PUBLIC_READ,
    });

    const privateBucket = new s3.Bucket(
      this,
      buildResourceId("private-bucket"),
      {
        bucketName: buildResourceId("private-bucket"),
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        publicReadAccess: false,
      }
    );

    const cloudFrontDistribution = new cloudfront.CloudFrontWebDistribution(
      this,
      buildResourceId("cloudfront"),
      {
        originConfigs: [
          {
            s3OriginSource: {
              s3BucketSource: bucket,
            },
            behaviors: [
              {
                isDefaultBehavior: true,
              },
            ],
          },
        ],
      }
    );

    const dbSubnetGroup = new rds.CfnDBSubnetGroup(
      this,
      buildResourceId("db-subnet"),
      {
        dbSubnetGroupDescription: "Subnet group to access database",
        dbSubnetGroupName: buildResourceId("db-subnet"),
        subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
      }
    );

    const dbSecurityGroup = new ec2.SecurityGroup(
      this,
      buildResourceId("db-security-group"),
      {
        securityGroupName: buildResourceId("db-security-group"),
        vpc,
        allowAllOutbound: false,
      }
    );

    const dbCredentialsSecret = new rds.DatabaseSecret(
      this,
      buildResourceId("db-secret"),
      { secretName: buildResourceId("db-secret"), username: "dbusername" }
    );

    const parameterGroup = new rds.ParameterGroup(
      this,
      buildResourceId("dbparam-group"),
      {
        engine: rds.DatabaseClusterEngine.auroraMysql({
          version: rds.AuroraMysqlEngineVersion.VER_3_02_1,
        }),
        parameters: {
          innodb_lock_wait_timeout: "120",
        },
      }
    );

    const dbCluster = new rds.DatabaseCluster(this, buildResourceId("db"), {
      clusterIdentifier: buildResourceId("db"),
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_02_1,
      }),
      parameterGroup: parameterGroup,
      instances: 1,
      credentials: rds.Credentials.fromSecret(dbCredentialsSecret),
      defaultDatabaseName: "dbname",
      instanceProps: {
        vpc: vpc,
        instanceType: new InstanceType("serverless"),
        autoMinorVersionUpgrade: true,
        publiclyAccessible: true,
        securityGroups: [dbSecurityGroup],
        vpcSubnets: vpc.selectSubnets({
          subnetType: SubnetType.PUBLIC, // use the public subnet created above for the db
        }),
      },
      deletionProtection: false,
      port: 3306, // use port 5432 instead of 3306
    });

    Aspects.of(dbCluster).add({
      visit(node) {
        if (node instanceof rds.CfnDBCluster) {
          node.serverlessV2ScalingConfiguration = {
            minCapacity: props.resources.dbCapacity[0],
            maxCapacity: props.resources.dbCapacity[1],
          };
        }
      },
    });

    const dbPort = ec2.Port.tcp(
      cdk.Token.asNumber(dbCluster.clusterEndpoint.port)
    );

    const dbConnections = new ec2.Connections({
      securityGroups: [dbSecurityGroup],
      defaultPort: dbPort,
    });

    dbSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      "allow SSH access from anywhere"
    );

    const redisSecurityGroup = new ec2.SecurityGroup(
      this,
      buildResourceId("redis-security-group"),
      {
        securityGroupName: buildResourceId("redis-security-group"),
        vpc,
        allowAllOutbound: true,
      }
    );

    const redisSubnetGroup = new elasticache.CfnSubnetGroup(
      this,
      buildResourceId("redis-subnet-group"),
      {
        subnetIds: vpc.privateSubnets.map((s) => s.subnetId),
        description: "subnet group for redis",
      }
    );

    const redisCluster = new elasticache.CfnCacheCluster(
      this,
      buildResourceId("redis-cluster"),
      {
        clusterName: buildResourceId("redis-cluster"),
        engine: "redis",
        engineVersion: "6.x",
        cacheNodeType: props.resources.redisType,
        numCacheNodes: 1,
        cacheSubnetGroupName: redisSubnetGroup.ref,
        vpcSecurityGroupIds: [redisSecurityGroup.securityGroupId],
      }
    );

    const cacheClusterPort = Port.tcp(
      Token.asNumber(redisCluster.attrRedisEndpointPort)
    );

    const cacheClusterConnections = new Connections({
      securityGroups: [redisSecurityGroup],
      defaultPort: cacheClusterPort,
    });

    const publicHostedZone = new route53.PublicHostedZone(
      this,
      buildResourceId("hosted-zone"),
      {
        zoneName: props.domain.replace("www.", ""),
      }
    );

    new route53.CaaAmazonRecord(this, buildResourceId("dns-caa-record"), {
      recordName: "",
      zone: publicHostedZone,
      ttl: Duration.minutes(1),
    });

    const cert = new Certificate(this, buildResourceId("cert"), {
      domainName: publicHostedZone.zoneName,
      certificateName: buildResourceId("cert"),
      validation: CertificateValidation.fromDns(publicHostedZone),
      subjectAlternativeNames: props.domain.includes("www.")
        ? [`www.${publicHostedZone.zoneName}`]
        : [],
    });

    const envSecret = asm.Secret.fromSecretCompleteArn(
      this,
      buildResourceId("web-secret"),
      props.envSecretId
    );

    const fargateService =
      new ecs_patterns.ApplicationLoadBalancedFargateService(
        this,
        buildResourceId("fargate"),
        {
          serviceName: buildResourceId("fargate"),
          loadBalancerName: buildResourceId("load-balancer"),
          cluster,
          cpu: props.resources.containerCpu,
          memoryLimitMiB: props.resources.containerMemory,
          desiredCount: 1,
          taskImageOptions: {
            image: ecs.ContainerImage.fromEcrRepository(ecrRepository),
            environment: {
              APP_DOMAIN: props.domain,
              BASE_DOMAIN: publicHostedZone.zoneName,
              AWS_BUCKET: bucket.bucketName,
              AWS_PRIVATE_BUCKET: privateBucket.bucketName,
              DB_CONNECTION: "mysql",
              DB_HOST: dbCluster.clusterEndpoint.hostname,
              DB_PORT: dbCluster.clusterEndpoint.port.toString(),
              DB_DATABASE: "dbname",
              AWS_DEFAULT_REGION: "eu-west-2",
              REDIS_HOST: redisCluster.attrRedisEndpointAddress,
              AWS_URL: `https://${cloudFrontDistribution.distributionDomainName}`,
              // SESSION_COOKIE: buildResourceId("session"),
              // STOREFRONT_SESSION_COOKIE: buildResourceId("storefront-session"),
              AWS_ECS_CLUSTER: buildResourceId("cluster"),
              AWS_ECS_SERVICE: buildResourceId("fargate"),
            },
            secrets: {
              DB_USERNAME: ecs.Secret.fromSecretsManager(
                dbCredentialsSecret,
                "username"
              ),
              DB_PASSWORD: ecs.Secret.fromSecretsManager(
                dbCredentialsSecret,
                "password"
              ),
            },
            enableLogging: true,
          },
          enableExecuteCommand: true,
          publicLoadBalancer: true, // Default is true
        }
      );

    secretEnvKeys.forEach((secretKey) => {
      fargateService.taskDefinition.defaultContainer?.addSecret(
        secretKey,
        ecs.Secret.fromSecretsManager(envSecret, secretKey)
      );
    });

    envSecret.grantRead(fargateService.taskDefinition.taskRole);

    bucket.grantReadWrite(fargateService.taskDefinition.taskRole);
    privateBucket.grantReadWrite(fargateService.taskDefinition.taskRole);

    fargateService.targetGroup.configureHealthCheck({
      path: "/api/health-check",
      interval: Duration.seconds(120),
      unhealthyThresholdCount: 5,
      timeout: Duration.seconds(40),
    });

    fargateService.loadBalancer.addListener(buildResourceId("https-listener"), {
      certificates: [cert],
      protocol: ApplicationProtocol.HTTPS,
      port: 443,
      sslPolicy: SslPolicy.RECOMMENDED,
      open: true,
      defaultTargetGroups: [fargateService.targetGroup],
    });

    fargateService.service.connections.allowTo(
      {
        connections: dbConnections,
      },
      dbPort
    );

    new route53.ARecord(this, buildResourceId("dns-a-record"), {
      recordName: props.domain,
      zone: publicHostedZone,
      target: route53.RecordTarget.fromAlias(
        new cdk.aws_route53_targets.LoadBalancerTarget(
          fargateService.loadBalancer
        )
      ),
      ttl: Duration.minutes(1),
    });

    if (props.domain.includes("www.")) {
      new route53.ARecord(this, buildResourceId("dns-www-record"), {
        recordName: "",
        zone: publicHostedZone,
        target: route53.RecordTarget.fromAlias(
          new cdk.aws_route53_targets.LoadBalancerTarget(
            fargateService.loadBalancer
          )
        ),
        ttl: Duration.minutes(1),
      });
    }

    fargateService.taskDefinition.taskRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
    );

    fargateService.taskDefinition.taskRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonSESFullAccess")
    );

    fargateService.taskDefinition.taskRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonS3FullAccess")
    );

    fargateService.taskDefinition.taskRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName(
        "AmazonElasticFileSystemFullAccess"
      )
    );

    fargateService?.taskDefinition?.executionRole?.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonS3FullAccess")
    );

    cacheClusterConnections.allowDefaultPortFrom(fargateService.service);

    const scalableTarget = fargateService.service.autoScaleTaskCount({
      minCapacity: 1,
      maxCapacity: 4,
    });

    scalableTarget.scaleOnCpuUtilization(
      buildResourceId("fargate-cpu-scaling"),
      {
        targetUtilizationPercent: 60,
      }
    );

    scalableTarget.scaleOnMemoryUtilization(
      buildResourceId("fargate-memory-scaling"),
      {
        targetUtilizationPercent: 60,
      }
    );

    const ec2Instance = new ec2.Instance(this, buildResourceId("jump-host"), {
      instanceName: buildResourceId("jump-host"),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
      securityGroup: dbSecurityGroup,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T2,
        ec2.InstanceSize.NANO
      ),
      machineImage: new ec2.AmazonLinuxImage({
        generation: ec2.AmazonLinuxGeneration.AMAZON_LINUX_2,
      }),
      keyName: "devons-mbp",
    });

    ec2Instance.connections.allowTo(
      {
        connections: dbConnections,
      },
      dbPort
    );

    new cdk.CfnOutput(this, "load-balancer-domain", {
      value: fargateService.loadBalancer.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, "ecr-repo-url", {
      value: ecrRepository.repositoryUri,
    });
  }
}
