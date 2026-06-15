import React, { useState } from 'react';
import NoteBlock from './NoteBlock';
import DatePicker from './DatePicker';

interface NoteEditorProps {
  note: any;
}

const NoteEditor: React.FC<NoteEditorProps> = ({ note }) => {
  const [selectedBlockType, setSelectedBlockType] = useState('text');
  const [date, setDate] = useState(null);

  const handleBlockTypeChange = (blockType: string) => {
    setSelectedBlockType(blockType);
  };

  const handleDateChange = (date: Date) => {
    setDate(date);
  };

  return (
    <div>
      <NoteBlock
        type={selectedBlockType}
        note={note}
        onBlockTypeChange={handleBlockTypeChange}
      />
      {selectedBlockType === 'date' && (
        <DatePicker
          date={date}
          onChange={handleDateChange}
        />
      )}
    </div>
  );
};

export default NoteEditor;