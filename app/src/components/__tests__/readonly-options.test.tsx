import React, { act } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { SelectList } from '../SelectList';
import { Tappable } from '../ui';

test('read-only model and effort lists preserve the selection and disable their controls', async () => {
  const options = [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }];
  let rendered!: ReactTestRenderer;
  await act(async () => { rendered = create(<SelectList options={options} value="high" onPick={jest.fn()} disabled />); });
  try {
    const controls = rendered.root.findAllByType(Tappable);
    expect(controls.map((row) => row.props.disabled)).toEqual([true, true]);
    expect(controls.map((row) => row.props.accessibilityState.selected)).toEqual([false, true]);
  } finally { await act(async () => rendered.unmount()); }
});
