import {
  buildStreamTitle,
  buildStreamTitleLive,
  buildStreamDescription,
  buildThumbnailCommand,
  buildTags,
  type StreamMetadataInput,
} from './metadata';

describe('buildStreamTitle', () => {
  it('generates title with generation number', () => {
    const title = buildStreamTitle({ generation: 1, template: '【AI Minecraft】星守レイのハードコア生存実験 #Gen{世代番号}' });
    expect(title).toBe('【AI Minecraft】星守レイのハードコア生存実験 #Gen1');
  });

  it('supports custom template', () => {
    const title = buildStreamTitle({ generation: 42, template: 'MC生存 第{世代番号}世代' });
    expect(title).toBe('MC生存 第42世代');
  });

  it('handles generation number > 999', () => {
    const title = buildStreamTitle({ generation: 1234, template: '#Gen{世代番号}' });
    expect(title).toBe('#Gen1234');
  });
});

describe('buildStreamTitleLive', () => {
  it('appends survival minutes and emoji', () => {
    const t = buildStreamTitleLive({
      generation: 5,
      survivalMinutes: 42,
      baseTemplate: '【AI Minecraft】#Gen{世代番号}',
    });
    expect(t).toBe('【AI Minecraft】#Gen5 🔴 42分生存中');
  });
});

describe('buildStreamDescription', () => {
  const input: StreamMetadataInput = {
    generation: 5,
    bestRecordMinutes: 240,
    totalDeaths: 4,
    descriptionTemplate: `🎮 AI VTuber「星守レイ」が Minecraft ハードコアモードに挑戦中！
現在: 第{世代番号}世代 ｜ 最高記録: {最高記録}
累計死亡: {累計死亡}回

AIが自律的に思考・判断・実況しながらサバイバルします。
死んだら全てリセット。何世代まで生き延びられるか？`,
  };

  it('replaces generation placeholder', () => {
    const desc = buildStreamDescription(input);
    expect(desc).toContain('第5世代');
  });

  it('replaces best record placeholder', () => {
    const desc = buildStreamDescription(input);
    expect(desc).toContain('最高記録: 4:00');
  });

  it('replaces total deaths placeholder', () => {
    const desc = buildStreamDescription(input);
    expect(desc).toContain('累計死亡: 4回');
  });

  it('handles zero best record', () => {
    const desc = buildStreamDescription({ ...input, bestRecordMinutes: 0 });
    expect(desc).toContain('最高記録: 0:00');
  });
});

describe('buildTags', () => {
  it('returns fixed tags array', () => {
    const tags = buildTags();
    expect(tags).toContain('Minecraft');
    expect(tags).toContain('AI');
    expect(tags).toContain('VTuber');
    expect(tags).toContain('ハードコア');
    expect(tags.length).toBeGreaterThanOrEqual(5);
  });
});

describe('buildThumbnailCommand', () => {
  const input = {
    backgroundPath: 'assets/thumbnail/bg.png',
    avatarPath: 'assets/thumbnail/rei.png',
    outputPath: '/tmp/thumbnail.png',
    generation: 7,
    isNewRecord: false,
    fontPath: 'assets/fonts/NotoSansJP-Bold.ttf',
  };

  it('generates ImageMagick convert command', () => {
    const cmd = buildThumbnailCommand(input);
    expect(cmd.command).toBe('convert');
  });

  it('starts with background image', () => {
    const cmd = buildThumbnailCommand(input);
    expect(cmd.args[0]).toBe('assets/thumbnail/bg.png');
  });

  it('includes avatar composite', () => {
    const cmd = buildThumbnailCommand(input);
    const argsStr = cmd.args.join(' ');
    expect(argsStr).toContain('assets/thumbnail/rei.png');
    expect(argsStr).toContain('-composite');
  });

  it('includes generation number text', () => {
    const cmd = buildThumbnailCommand(input);
    const argsStr = cmd.args.join(' ');
    expect(argsStr).toContain('#Gen7');
  });

  it('includes fixed title text', () => {
    const cmd = buildThumbnailCommand(input);
    const argsStr = cmd.args.join(' ');
    expect(argsStr).toContain('AI ハードコア生存実験');
  });

  it('adds record badge when isNewRecord is true', () => {
    const cmd = buildThumbnailCommand({ ...input, isNewRecord: true });
    const argsStr = cmd.args.join(' ');
    expect(argsStr).toContain('記録更新中');
  });

  it('does not add record badge when isNewRecord is false', () => {
    const cmd = buildThumbnailCommand({ ...input, isNewRecord: false });
    const argsStr = cmd.args.join(' ');
    expect(argsStr).not.toContain('記録更新中');
  });

  it('outputs to specified path', () => {
    const cmd = buildThumbnailCommand(input);
    expect(cmd.args[cmd.args.length - 1]).toBe('/tmp/thumbnail.png');
  });

  it('targets 1280x720 canvas', () => {
    const cmd = buildThumbnailCommand(input);
    const argsStr = cmd.args.join(' ');
    expect(argsStr).toContain('1280x720');
  });
});
