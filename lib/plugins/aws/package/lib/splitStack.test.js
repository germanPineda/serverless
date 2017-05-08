'use strict';

const path = require('path');
const fse = require('fs-extra');
const expect = require('chai').expect;
const sinon = require('sinon');
const testUtils = require('../../../../../tests/utils');
const AwsPackage = require('../index');
const Serverless = require('../../../../Serverless');
const AwsProvider = require('../../provider/awsProvider');

describe('splitStack', () => {
  const cfRawFilePath = path.join(__dirname, 'splitStack.test.cfRaw.json');
  const cfNested1FilePath = path.join(__dirname, 'splitStack.test.cfNested1.json');
  const cfNested2FilePath = path.join(__dirname, 'splitStack.test.cfNested2.json');
  const cfUpdatedFilePath = path.join(__dirname, 'splitStack.test.cfUpdated.json');
  const depGraphFilePath = path.join(__dirname, 'splitStack.test.depGraph.json');
  const cfRawFileContent = fse.readJsonSync(cfRawFilePath);
  const cfNested1FileContent = fse.readJsonSync(cfNested1FilePath);
  const cfNested2FileContent = fse.readJsonSync(cfNested2FilePath);
  const cfUpdatedFileContent = fse.readJsonSync(cfUpdatedFilePath);
  const depGraphFileContent = fse.readJsonSync(depGraphFilePath);
  let serverless;
  let awsPackage;

  beforeEach(() => {
    serverless = new Serverless();
    serverless.setProvider('aws', new AwsProvider(serverless));
    awsPackage = new AwsPackage(serverless, {});
    serverless.service = {
      package: {
        artifactDirectoryName: 'some-directory',
      },
      provider: {
        compiledCloudFormationTemplate: cfRawFileContent,
        cloudFormationDependencyGraph: null,
        nestedStacks: [],
      },
    };
  });

  describe('#splitStack()', () => {
    let createDependencyGraphStub;
    let generateNestedStacksStub;
    let writeStacksToDiskStub;
    let updateCompiledCloudFormationTemplateStub;

    beforeEach(() => {
      createDependencyGraphStub = sinon
        .stub(awsPackage, 'createDependencyGraph').resolves();
      generateNestedStacksStub = sinon
        .stub(awsPackage, 'generateNestedStacks').resolves();
      writeStacksToDiskStub = sinon
        .stub(awsPackage, 'writeStacksToDisk').resolves();
      updateCompiledCloudFormationTemplateStub = sinon
        .stub(awsPackage, 'updateCompiledCloudFormationTemplate').resolves();
    });

    afterEach(() => {
      awsPackage.createDependencyGraph.restore();
      awsPackage.generateNestedStacks.restore();
      awsPackage.writeStacksToDisk.restore();
      awsPackage.updateCompiledCloudFormationTemplate.restore();
    });

    it('should resolve if useStackSplitting config variable is not set', () => awsPackage
      .splitStack().then(() => {
        expect(createDependencyGraphStub.calledOnce).to.equal(false);
        expect(generateNestedStacksStub.calledOnce).to.equal(false);
        expect(writeStacksToDiskStub.calledOnce).to.equal(false);
        expect(updateCompiledCloudFormationTemplateStub.calledOnce).to.equal(false);
      })
    );

    it('should run promise chain if useStackSplitting config variable is set', () => {
      awsPackage.serverless.service.provider.useStackSplitting = true;

      return awsPackage.splitStack().then(() => {
        expect(createDependencyGraphStub.calledOnce).to.equal(true);
        expect(generateNestedStacksStub.calledAfter(createDependencyGraphStub)).to.equal(true);
        expect(writeStacksToDiskStub.calledAfter(generateNestedStacksStub)).to.equal(true);
        expect(updateCompiledCloudFormationTemplateStub
          .calledAfter(writeStacksToDiskStub)).to.equal(true);
      });
    });
  });

  describe('#createDependencyGraph()', () => {
    it('should compute a valid dependency graph', () => awsPackage
      .createDependencyGraph().then(() => {
        const depGraph = awsPackage.serverless.service.provider.cloudFormationDependencyGraph;

        expect(depGraph.nodes).to.deep.equal(depGraphFileContent.nodes);
        expect(depGraph.outgoingEdges).to.deep.equal(depGraphFileContent.outgoingEdges);
        expect(depGraph.incomingEdges).to.deep.equal(depGraphFileContent.incomingEdges);
      })
    );
  });

  describe('#generateNestedStacks()', () => {
    beforeEach(() => {
      awsPackage.createDependencyGraph();
    });

    it('should generate and append the resources for the nested stacks', () => {
      const nestedStacks = awsPackage.serverless.service.provider.nestedStacks;
      const nestedStack1Resource = {
        NestedStack1: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            Parameters: {
              ServerlessDeploymentBucket: { Ref: 'ServerlessDeploymentBucket' },
              ResourcesDynamoDBStream: { 'Fn::GetAtt': ['ResourcesDynamoDBStream', 'StreamArn'] },
              ResourcesKinesisStream: { Ref: 'ResourcesKinesisStream' },
              IamRoleLambdaExecution: { 'Fn::GetAtt': ['IamRoleLambdaExecution', 'Arn'] },
            },
            TemplateURL: 'https://s3.amazonaws.com/%DEPLOYMENT-BUCKET-NAME%/some-directory/cloudformation-template-nested-stack-1.json',
          },
          Description: 'Stack for function \"HelloLambdaFunction\" and its dependencies', // eslint-disable-line
          DependsOn: [
            'ServerlessDeploymentBucket',
            'ResourcesDynamoDBStream',
            'ResourcesKinesisStream',
            'IamRoleLambdaExecution',
          ],
        },
      };
      const nestedStack2Resource = {
        NestedStack2: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: {
            Parameters: {
              ServerlessDeploymentBucket: { Ref: 'ServerlessDeploymentBucket' },
              ResourcesDynamoDBStream: { Ref: 'ResourcesDynamoDBStream' },
              ResourcesKinesisStream: { 'Fn::GetAtt': ['ResourcesKinesisStream', 'Arn'] },
              IamRoleLambdaExecution: { 'Fn::GetAtt': ['IamRoleLambdaExecution', 'Arn'] },
            },
            TemplateURL: 'https://s3.amazonaws.com/%DEPLOYMENT-BUCKET-NAME%/some-directory/cloudformation-template-nested-stack-2.json',
          },
          Description: 'Stack for function \"GoodbyeLambdaFunction\" and its dependencies', //eslint-disable-line
          DependsOn: [
            'ServerlessDeploymentBucket',
            'ResourcesDynamoDBStream',
            'ResourcesKinesisStream',
            'IamRoleLambdaExecution',
          ],
        },
      };

      return awsPackage.generateNestedStacks().then(() => {
        expect(nestedStacks[0].stackTemplate).to.deep.equal(cfNested1FileContent);
        expect(nestedStacks[1].stackTemplate).to.deep.equal(cfNested2FileContent);
        expect(nestedStacks[0].stackResource).to.deep.equal(nestedStack1Resource);
        expect(nestedStacks[1].stackResource).to.deep.equal(nestedStack2Resource);
      });
    });
  });

  describe('#writeStacksToDisk()', () => {
    it('should write the generated nested stack templates to disk', () => {
      const tmpDirPath = testUtils.getTmpDirPath();
      const serverlessDirPath = path.join(tmpDirPath, '.serverless');
      const nestedStackFile1 = 'cloudformation-template-nested-stack-1.json';
      const nestedStackFile2 = 'cloudformation-template-nested-stack-2.json';
      const nestedStackFile1Path = path.join(serverlessDirPath, nestedStackFile1);
      const nestedStackFile2Path = path.join(serverlessDirPath, nestedStackFile2);
      fse.mkdirsSync(serverlessDirPath);
      awsPackage.serverless.config.servicePath = tmpDirPath;

      const nestedStacks = [
        {
          stackResource: {
            NestedStack1: {
              Properties: {
                TemplateURL: `s3-bucket/${nestedStackFile1}`,
              },
            },
          },
          stackTemplate: '{ "nestedStack": "nested-stack-1" }',
        },
        {
          stackResource: {
            NestedStack2: {
              Properties: {
                TemplateURL: `s3-bucket/${nestedStackFile2}`,
              },
            },
          },
          stackTemplate: '{ "nestedStack": "nested-stack-2" }',
        },
      ];

      awsPackage.serverless.service.provider.nestedStacks = nestedStacks;

      return awsPackage.writeStacksToDisk().then(() => {
        const nestedStackFile1Content = fse.readJsonSync(nestedStackFile1Path);
        const nestedStackFile2Content = fse.readJsonSync(nestedStackFile2Path);

        expect(nestedStackFile1Content.nestedStack).to.equal('nested-stack-1');
        expect(nestedStackFile2Content.nestedStack).to.equal('nested-stack-2');
      });
    });
  });

  describe('#updateCompiledCloudFormationTemplate()', () => {
    beforeEach(() => {
      awsPackage.createDependencyGraph();
      awsPackage.generateNestedStacks();
    });

    it('should update the in-memory representation of the compiled CloudFormation template', () => {
      const compiledCfTemplate = awsPackage.serverless.service
        .provider.compiledCloudFormationTemplate;

      return awsPackage.updateCompiledCloudFormationTemplate().then(() => {
        expect(compiledCfTemplate).to.deep.equal(cfUpdatedFileContent);
      });
    });
  });
});
