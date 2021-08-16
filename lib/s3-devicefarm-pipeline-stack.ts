/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this
 * software and associated documentation files (the "Software"), to deal in the Software
 * without restriction, including without limitation the rights to use, copy, modify,
 * merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
 * PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
 * HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import * as cdk from '@aws-cdk/core';
import * as codepipeline from '@aws-cdk/aws-codepipeline';
import * as iam from '@aws-cdk/aws-iam';
import * as s3 from '@aws-cdk/aws-s3';
import * as s3Deployment from '@aws-cdk/aws-s3-deployment';
import * as actions from '@aws-cdk/aws-codepipeline-actions';
import * as customResource from '@aws-cdk/custom-resources';
import * as codebuild from '@aws-cdk/aws-codebuild';
import * as lambda from '@aws-cdk/aws-lambda';
import * as path from 'path';
import { Duration } from '@aws-cdk/core';

export class S3DevicefarmPipelineStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // create a device-farm project as a custom resource
    const dfProjectName = "s3DeviceFarmPipeline"
    const devicefarmProject = new customResource.AwsCustomResource(this, "deviceFarmPipeline",{
      onCreate: {
        service: 'DeviceFarm',
        action: 'createProject',
        parameters: {
          name: dfProjectName
        },
        physicalResourceId: customResource.PhysicalResourceId.fromResponse('project.arn'),
      },
      onUpdate: {
        service: 'DeviceFarm',
        action: 'updateProject',
        parameters: {
          name: dfProjectName,
          arn: new customResource.PhysicalResourceIdReference().toString(),
        },
        physicalResourceId: customResource.PhysicalResourceId.fromResponse('project.arn'),
      },
      onDelete: {
        service: 'DeviceFarm',
        action: 'deleteProject',
        parameters: {
          arn: new customResource.PhysicalResourceIdReference().toString()
        },
      },
      policy: customResource.AwsCustomResourcePolicy.fromSdkCalls({ resources: customResource.AwsCustomResourcePolicy.ANY_RESOURCE })
    });

    /*
    * Create a Device Pool to use with the project. We are going to test this with an
    * Android APK and Java TestNG Project. So we will create an Android only device pool
    * with just highly available android devices. Change the device pool rules in case
    * you plan to use other OS like Ios. 
    * 
    * You can alternative create alternate device pools as well.
    */
    const devicePoolName = "Google Highly Available Devices";
    const devicePoolDescription = "Google Highly Available";
    const devicePoolRules = [
      {attribute: "MANUFACTURER", operator:"EQUALS", value: "\"Google\"" },
      {attribute: "AVAILABILITY", operator:"EQUALS", value: "\"HIGHLY_AVAILABLE\"" }
    ]
    const devicePool = new customResource.AwsCustomResource(this, "deviceFarmPipelinePool",{
      onCreate: {
        service: 'DeviceFarm',
        action: 'createDevicePool',
        parameters: {
          name: devicePoolName,
          description: devicePoolDescription,
          projectArn:devicefarmProject.getResponseField("project.arn"),
          rules:devicePoolRules,
          maxDevices:2,
        },
        physicalResourceId: customResource.PhysicalResourceId.fromResponse('devicePool.arn'),
      },
      onUpdate: {
        service: 'DeviceFarm',
        action: 'updateDevicePool',
        parameters: {
          name: devicePoolName,
          description: devicePoolDescription,
          rules:devicePoolRules,
          arn: new customResource.PhysicalResourceIdReference().toString(),
        },
        physicalResourceId: customResource.PhysicalResourceId.fromResponse('devicePool.arn'),
      },
      onDelete: {
        service: 'DeviceFarm',
        action: 'deleteDevicePool',
        parameters: {
          arn: new customResource.PhysicalResourceIdReference().toString()
        },
      },
      policy: customResource.AwsCustomResourcePolicy.fromSdkCalls({ resources: customResource.AwsCustomResourcePolicy.ANY_RESOURCE })
    });



    // create a source s3 bucket to hold build artifacts.
    // During tests, you need to upload a zip file with 
    // the app binary, the test cases binaries, a code build
    // spec file and other dependencies
    const appBucket = new s3.Bucket(this, "appBucket",{
      versioned:true
    });
    
    
    // We will now create a code pipeline that connects the S3 bucket with the
    // device farm. For this we use a code build project that runs necessary
    // tests
    const pipeline = new codepipeline.Pipeline(this, 's3-devicefarm-pipeline', {
      pipelineName: 's3-devicefarm-pipeline'
    });

    // provide pipeline access to devicefarm and S3
    const pipelineRole = pipeline.role;
    pipelineRole.addManagedPolicy(iam.ManagedPolicy.fromManagedPolicyArn(this,"s3ManagedPolicy","arn:aws:iam::aws:policy/AmazonS3FullAccess"))
    
    

    // Configure the cope pipeline with 3 stages
    // 1. Source stage with a source action for triggering
    // the pipeline on source uploads to s3
    // 2. Test Stage with a codebuild action for doing the actual tests
    // and collecting the results
    // 3. Report stage with an S3 deply action to store the devicefarm
    // results in S3
    
    // Source stage
    const sourceStage = pipeline.addStage({
      stageName:"Source",
    })
    const sourceOutput = new codepipeline.Artifact("appArtifact");
    sourceStage.addAction(
      new actions.S3SourceAction({
        actionName: "s3SourceAction",
        bucket: appBucket,
        bucketKey: "app.zip",
        output: sourceOutput
    }))

    // Test stage
    const testOutput = new codepipeline.Artifact("testArtifact");
    const testStage = pipeline.addStage({
      stageName:"Test",
      placement:{
        justAfter:sourceStage
      }
    })
    // create a codebuild project and add it as a test action
    const codebuildProject = new codebuild.PipelineProject(this, 'CodebuildProject',{
      environmentVariables:{
        "DEVICEFARM_ARN": { 
          value: devicefarmProject.getResponseField("project.arn"), 
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT
        },
        "DEVICEPOOL_ARN": { 
          value: devicePool.getResponseField("devicePool.arn"), 
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT
        }
      },
      timeout: Duration.minutes(180)
    });
    // const devicefarmPolicy = new iam.Policy(this, 'devicefarmPolicy')
    const devicefarmAccessStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions:[
        "devicefarm:ListProjects",
        "devicefarm:ListDevicePools",
        "devicefarm:GetRun",
        "devicefarm:GetUpload",
        "devicefarm:CreateUpload",
        "devicefarm:ScheduleRun",
        "devicefarm:ListSuites",
        "devicefarm:ListTests",
        "devicefarm:ListRuns",
        "devicefarm:ListArtifacts",
        "devicefarm:ListJobs",
      ],
      resources:["*"]
    })
    codebuildProject.addToRolePolicy(devicefarmAccessStatement)

    testStage.addAction(new actions.CodeBuildAction({
      actionName:"s3DeviceFarmTest",
      project:codebuildProject,
      input:sourceOutput,
      outputs:[testOutput],
      type:actions.CodeBuildActionType.TEST
    }))

    // add a report stage with an s3 deploy action
    const reportStage = pipeline.addStage({
      stageName:"Report",
      placement:{
        justAfter:testStage
      }
    })
    reportStage.addAction(
      new actions.S3DeployAction({
        actionName: "s3DeployAction",
        bucket: appBucket,
        input: testOutput,
        extract: true
    }))

    // output the s3 bucket url to use when uploading the app binaries
    // into S3
    new cdk.CfnOutput(this, 's3AppBucket', { value: `s3://${appBucket.bucketName}` })
    
  }
}
